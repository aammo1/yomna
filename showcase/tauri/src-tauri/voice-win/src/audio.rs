// Audio in: the default microphone (cpal: WASAPI on Windows, ALSA on Linux, which PipeWire and PulseAudio
// both answer) or a WAV file played in real time (dev tests), both mixed down to mono 16 kHz for Parakeet and
// metered for the listening animation.

use crate::{Ev, RATE};
#[cfg(any(windows, target_os = "linux"))]
use crate::log;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Mono, any rate in, 16 kHz out. Each output sample averages the input it covers (a box filter),
/// which is enough anti-aliasing for speech.
pub struct Resampler {
    step: f64,
    next: f64,
    base: usize,
    hist: Vec<f32>,
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Resampler { step: rate as f64 / RATE as f64, next: 0.0, base: 0, hist: Vec::new() }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.step == 1.0 {
            return out.extend_from_slice(input);
        }
        self.hist.extend_from_slice(input);
        let half = (self.step / 2.0).max(0.5);
        loop {
            let lo = (self.next - half).floor().max(0.0) as usize;
            let hi = (self.next + half).ceil() as usize;
            if hi > self.base + self.hist.len() {
                break;
            }
            let s = &self.hist[lo - self.base..hi - self.base];
            out.push(s.iter().sum::<f32>() / s.len() as f32);
            self.next += self.step;
        }
        let keep = ((self.next - half).floor().max(0.0) as usize).max(self.base);
        self.hist.drain(..keep - self.base);
        self.base = keep;
    }
}

/// 40 ms at 16 kHz = 640 samples = 1,280 bytes of signed 16-bit LE mono PCM.
pub const LIVE_FRAME_SAMPLES: usize = 640;

pub fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

pub fn encode_pcm_i16_le(samples: &[i16]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    STANDARD.encode(&bytes)
}

type PcmCallback = Box<dyn FnMut(&[i16]) + Send>;

struct LiveChunker {
    pending: Vec<i16>,
    on_frame: PcmCallback,
}

impl LiveChunker {
    fn new(on_frame: PcmCallback) -> Self {
        LiveChunker { pending: Vec::with_capacity(LIVE_FRAME_SAMPLES * 2), on_frame }
    }

    fn push_f32(&mut self, samples: &[f32]) {
        self.pending.extend(samples.iter().copied().map(f32_to_i16));
        while self.pending.len() >= LIVE_FRAME_SAMPLES {
            (self.on_frame)(&self.pending[..LIVE_FRAME_SAMPLES]);
            self.pending.drain(..LIVE_FRAME_SAMPLES);
        }
    }
}

/// Where captured audio goes: the take buffer (16 kHz mono) or a Live Mode 640-sample PCM frame callback,
/// plus level events.
pub struct Sink {
    buf: Arc<Mutex<Vec<f32>>>,
    tx: Sender<Ev>,
    resampler: Option<Resampler>,
    channels: usize,
    mono: Vec<f32>,
    out: Vec<f32>,
    live: Option<LiveChunker>,
}

impl Sink {
    pub fn new(buf: Arc<Mutex<Vec<f32>>>, tx: Sender<Ev>) -> Self {
        Sink { buf, tx, resampler: None, channels: 1, mono: Vec::new(), out: Vec::new(), live: None }
    }

    /// A streaming sink for Live Mode: resamples to 16 kHz mono and emits 640-sample (40 ms)
    /// i16 frames via `on_frame` without accumulating audio in `buf`.
    pub fn live(tx: Sender<Ev>, on_frame: impl FnMut(&[i16]) + Send + 'static) -> Self {
        Sink {
            buf: Arc::new(Mutex::new(Vec::new())),
            tx,
            resampler: None,
            channels: 1,
            mono: Vec::new(),
            out: Vec::new(),
            live: Some(LiveChunker::new(Box::new(on_frame))),
        }
    }

    fn start(&mut self, rate: u32, channels: usize) {
        self.resampler = Some(Resampler::new(rate));
        self.channels = channels.max(1);
    }

    /// Interleaved samples at the rate and channel count given to start().
    pub fn feed(&mut self, data: &[f32]) {
        let ch = self.channels;
        self.mono.clear();
        self.mono.extend(data.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32));
        if self.mono.is_empty() {
            return;
        }
        let rms = (self.mono.iter().map(|s| s * s).sum::<f32>() / self.mono.len() as f32).sqrt();
        // Same scale as the Mac helper: about -55 dB is silence, -15 dB is loud speech.
        let level = ((20.0 * rms.max(1e-7).log10() as f64 + 55.0) / 40.0).clamp(0.0, 1.0);
        self.out.clear();
        if let Some(r) = self.resampler.as_mut() {
            r.push(&self.mono, &mut self.out);
        }
        if let Some(live) = self.live.as_mut() {
            live.push_f32(&self.out);
        } else {
            self.buf.lock().unwrap().extend_from_slice(&self.out);
        }
        let _ = self.tx.send(Ev::Level(level));
    }
}

/// Why the microphone didn't open or stopped: "missing", "busy", "blocked", "lost" or "failed", with the
/// system's own words. The app turns the reason into what Yomna says.
#[derive(Debug, Clone, PartialEq)]
pub struct MicError {
    pub reason: &'static str,
    pub detail: String,
}

impl MicError {
    pub fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        MicError { reason, detail: detail.into() }
    }
}

// E_ACCESSDENIED, which cpal passes on as an unclassified backend error: what a Windows desktop app gets when a
// privacy switch, a policy or security software keeps it off the microphone.
#[cfg(any(windows, target_os = "linux"))]
const ACCESS_DENIED: &str = "(os error -2147024891)";

/// A cpal error as a MicError, or None for a glitch the stream carries on through (a dropped buffer, a refused
/// priority boost, a rerouted default), which must not end the take. `opening`: while starting, not mid-take.
#[cfg(any(windows, target_os = "linux"))]
pub fn mic_problem(e: &cpal::Error, opening: bool) -> Option<MicError> {
    use cpal::ErrorKind::*;
    let detail = e.to_string();
    let reason = match e.kind() {
        Xrun | RealtimeDenied | DeviceChanged => return None,
        PermissionDenied => "blocked",
        _ if detail.contains(ACCESS_DENIED) => "blocked",
        DeviceBusy => "busy",
        DeviceNotAvailable if opening => "missing",
        DeviceNotAvailable | StreamInvalidated => "lost",
        _ => "failed",
    };
    Some(MicError { reason, detail })
}

#[cfg(any(windows, target_os = "linux"))]
fn open_failed(e: cpal::Error) -> MicError {
    mic_problem(&e, true).unwrap_or_else(|| MicError::new("failed", e.to_string()))
}

/// Recording stops when this is dropped.
pub struct Source {
    #[cfg(any(windows, target_os = "linux"))]
    _stream: Option<cpal::Stream>,
    stop: Arc<AtomicBool>,
}

impl Drop for Source {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / scale).collect()
        }
    };
    let ch = spec.channels.max(1) as usize;
    let mono: Vec<f32> = raw.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect();
    let mut out = Vec::new();
    Resampler::new(spec.sample_rate).push(&mono, &mut out);
    Ok((out, RATE))
}

/// Dev stand-in for the mic: plays a WAV into the sink at real speed, then silence until stopped.
pub fn play_file(path: &Path, mut sink: Sink) -> Result<Source, String> {
    let (samples, _) = read_wav(path)?;
    sink.start(RATE, 1);
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let chunk = RATE as usize / 50;
        let silence = vec![0.0f32; chunk];
        let mut i = 0;
        while !stop2.load(Ordering::Relaxed) {
            let piece = if i < samples.len() { &samples[i..(i + chunk).min(samples.len())] } else { &silence[..] };
            sink.feed(piece);
            i += chunk;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });
    Ok(Source {
        #[cfg(any(windows, target_os = "linux"))]
        _stream: None,
        stop,
    })
}

#[cfg(any(windows, target_os = "linux"))]
pub fn has_input() -> bool {
    use cpal::traits::HostTrait;
    cpal::default_host().default_input_device().is_some()
}

/// The mic picked in the panel, by name (cpal has no id that survives a replug); None is the default.
pub static CHOSEN: Mutex<Option<String>> = Mutex::new(None);

/// Names once each, in the order listed: the picker can't tell two mics with one name apart anyway.
#[cfg(any(windows, target_os = "linux", test))]
pub fn unique(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names.into_iter().filter(|n| !n.is_empty() && seen.insert(n.clone())).collect()
}

/// On Linux PipeWire/PulseAudio systems, hide raw ALSA hardware/plugin entries when "default",
/// "pipewire", or "pulse" exists, and keep "default" first if present.
#[cfg(any(target_os = "linux", test))]
pub fn filter_linux_mics(names: impl IntoIterator<Item = String>) -> Vec<String> {
    const RAW_PREFIXES: [&str; 10] = [
        "hw:", "plughw:", "sysdefault:", "dsnoop:", "dmix:",
        "iec958:", "spdif:", "hdmi:", "front:", "surround",
    ];
    const RAW_NAMES: [&str; 7] = [
        "null", "lavrate", "samplerate", "speexrate", "upmix", "vdownmix", "oss",
    ];
    let list = unique(names);
    let has_server = list.iter().any(|n| matches!(n.to_ascii_lowercase().as_str(), "default" | "pipewire" | "pulse"));
    let mut filtered: Vec<String> = if has_server {
        list.into_iter()
            .filter(|n| {
                let lower = n.to_ascii_lowercase();
                !RAW_PREFIXES.iter().any(|p| lower.starts_with(p))
                    && !RAW_NAMES.iter().any(|p| lower == *p || lower.starts_with(&format!("{p}:")))
            })
            .collect()
    } else {
        list
    };
    if let Some(pos) = filtered.iter().position(|n| n.eq_ignore_ascii_case("default")) {
        if pos > 0 {
            let def = filtered.remove(pos);
            filtered.insert(0, def);
        }
    }
    filtered
}

#[cfg(any(windows, target_os = "linux"))]
fn name_of(d: &cpal::Device) -> Option<String> {
    use cpal::traits::DeviceTrait;
    d.description().ok().map(|x| x.name().to_owned())
}

/// {"type":"mics"}: every input by name, the default's, and the pick (the panel's mic picker).
#[cfg(any(windows, target_os = "linux"))]
pub fn mics() -> serde_json::Value {
    use cpal::traits::HostTrait;
    let host = cpal::default_host();
    let raw = host.input_devices().map(|l| l.filter_map(|d| name_of(&d)).collect::<Vec<_>>()).unwrap_or_default();
    #[cfg(target_os = "linux")]
    let names = filter_linux_mics(raw);
    #[cfg(not(target_os = "linux"))]
    let names = unique(raw);
    let list: Vec<_> = names.iter().map(|n| serde_json::json!({ "id": n, "name": n })).collect();
    let default = host.default_input_device().and_then(|d| name_of(&d)).unwrap_or_default();
    serde_json::json!({ "type": "mics", "list": list, "default": default, "chosen": CHOSEN.lock().unwrap().clone().unwrap_or_default() })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn mics() -> serde_json::Value {
    serde_json::json!({ "type": "mics", "list": [], "default": "", "chosen": "" })
}

/// Every microphone the system lists, the default one, and the format each records in, or why it can't (--devices,
/// for diagnostics reports).
#[cfg(any(windows, target_os = "linux"))]
pub fn devices() -> serde_json::Value {
    use cpal::traits::{DeviceTrait, HostTrait};
    use serde_json::json;
    let host = cpal::default_host();
    let about = |d: &cpal::Device| {
        let name = d.description().map(|x| x.name().to_owned()).unwrap_or_else(|e| format!("(no name: {e})"));
        match d.default_input_config() {
            Ok(c) => json!({ "name": name, "format": format!("{:?} {} Hz {} ch", c.sample_format(), c.sample_rate(), c.channels()) }),
            Err(e) => {
                let p = open_failed(e);
                json!({ "name": name, "error": p.detail, "reason": p.reason })
            }
        }
    };
    let inputs = match host.input_devices() {
        Ok(list) => json!(list.map(|d| about(&d)).collect::<Vec<_>>()),
        Err(e) => json!({ "error": e.to_string() }),
    };
    json!({ "type": "devices", "host": host.id().name(), "default": host.default_input_device().map(|d| about(&d)), "inputs": inputs })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn devices() -> serde_json::Value {
    serde_json::json!({ "type": "devices", "unsupported": true })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn has_input() -> bool {
    false
}

#[cfg(any(windows, target_os = "linux"))]
pub fn open_mic(mut sink: Sink) -> Result<Source, MicError> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample, I24, U24};

    fn build<T>(dev: &cpal::Device, cfg: cpal::StreamConfig, mut sink: Sink, err_tx: Sender<Ev>) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut tmp = Vec::new();
        dev.build_input_stream::<T, _, _>(
            cfg,
            move |data: &[T], _| {
                tmp.clear();
                tmp.extend(data.iter().map(|&s| s.to_sample::<f32>()));
                sink.feed(&tmp);
            },
            move |e| {
                if let Some(p) = mic_problem(&e, false) {
                    let _ = err_tx.send(Ev::AudioFailed(p));
                }
            },
            None,
        )
    }

    // The picked mic while it's plugged in, else the default.
    let host = cpal::default_host();
    let chosen = CHOSEN.lock().unwrap().clone();
    let picked = chosen.and_then(|want| host.input_devices().ok()?.find(|d| name_of(d).as_deref() == Some(want.as_str())));
    let dev = picked.or_else(|| host.default_input_device()).ok_or_else(|| MicError::new("missing", "no default input device"))?;
    let supported = dev.default_input_config().map_err(open_failed)?;
    sink.start(supported.sample_rate(), supported.channels() as usize);
    let err_tx = sink.tx.clone();
    let format = supported.sample_format();
    let cfg: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&dev, cfg, sink, err_tx),
        SampleFormat::F64 => build::<f64>(&dev, cfg, sink, err_tx),
        SampleFormat::I8 => build::<i8>(&dev, cfg, sink, err_tx),
        SampleFormat::I16 => build::<i16>(&dev, cfg, sink, err_tx),
        // 24-bit mics (some USB and studio interfaces) come through as I24.
        SampleFormat::I24 => build::<I24>(&dev, cfg, sink, err_tx),
        SampleFormat::I32 => build::<i32>(&dev, cfg, sink, err_tx),
        SampleFormat::I64 => build::<i64>(&dev, cfg, sink, err_tx),
        SampleFormat::U8 => build::<u8>(&dev, cfg, sink, err_tx),
        SampleFormat::U16 => build::<u16>(&dev, cfg, sink, err_tx),
        SampleFormat::U24 => build::<U24>(&dev, cfg, sink, err_tx),
        SampleFormat::U32 => build::<u32>(&dev, cfg, sink, err_tx),
        other => return Err(MicError::new("failed", format!("unsupported sample format {other:?}"))),
    }
    .map_err(open_failed)?;
    stream.play().map_err(open_failed)?;
    log("microphone on");
    Ok(Source { _stream: Some(stream), stop: Arc::new(AtomicBool::new(false)) })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn open_mic(_sink: Sink) -> Result<Source, MicError> {
    Err(MicError::new("failed", "the microphone is only wired up on Windows and Linux (use --test-audio)"))
}

/// Opens the selected mic (or `test_audio` WAV stand-in) and streams 16 kHz i16 mono PCM frames
/// (640 samples / 1,280 bytes per chunk) into `on_frame` for Live Mode.
pub fn open_live_stream(
    tx: Sender<Ev>,
    test_audio: Option<&Path>,
    on_frame: impl FnMut(&[i16]) + Send + 'static,
) -> Result<Source, MicError> {
    let sink = Sink::live(tx, on_frame);
    match test_audio {
        Some(p) => play_file(p, sink).map_err(|e| MicError::new("failed", e)),
        None => open_mic(sink),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_raw_alsa_devices_when_pipewire_or_default_exists() {
        let raw = [
            "hw:CARD=PCH,DEV=0",
            "plughw:CARD=PCH,DEV=0",
            "sysdefault:CARD=PCH",
            "dsnoop:CARD=PCH,DEV=0",
            "dmix:CARD=PCH,DEV=0",
            "iec958:CARD=PCH,DEV=0",
            "spdif:CARD=PCH,DEV=0",
            "hdmi:CARD=NVidia,DEV=0",
            "front:CARD=PCH,DEV=0",
            "surround40:CARD=PCH,DEV=0",
            "null",
            "lavrate",
            "samplerate",
            "speexrate",
            "upmix",
            "vdownmix",
            "oss",
            "pipewire",
            "pulse",
            "Blue Yeti Stereo Microphone",
            "default",
            "pipewire",
        ]
        .map(String::from);
        assert_eq!(
            filter_linux_mics(raw),
            vec!["default", "pipewire", "pulse", "Blue Yeti Stereo Microphone"]
        );
    }

    #[test]
    fn keeps_raw_alsa_devices_when_no_sound_server_exists() {
        let raw = ["hw:CARD=USB,DEV=0", "plughw:CARD=USB,DEV=0", "hw:CARD=USB,DEV=0"].map(String::from);
        assert_eq!(filter_linux_mics(raw), vec!["hw:CARD=USB,DEV=0", "plughw:CARD=USB,DEV=0"]);
    }

    #[test]
    fn live_sink_resamples_and_encodes_640_sample_pcm_frames() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let (tx, rx) = std::sync::mpsc::channel();
        let frames = Arc::new(Mutex::new(Vec::<String>::new()));
        let frames_cb = frames.clone();
        let mut sink = Sink::live(tx, move |pcm| {
            frames_cb.lock().unwrap().push(encode_pcm_i16_le(pcm));
        });
        sink.start(48_000, 2);
        // 48 kHz * 0.08s = 3,840 stereo frames -> 1,280 samples @ 16 kHz -> two 640-sample frames.
        let mut interleaved = Vec::with_capacity(3_840 * 2);
        for _ in 0..3_840 {
            interleaved.push(0.5_f32);
            interleaved.push(0.5_f32);
        }
        sink.feed(&interleaved);
        let encoded = frames.lock().unwrap();
        assert_eq!(encoded.len(), 2);
        for b64 in encoded.iter() {
            let bytes = STANDARD.decode(b64).expect("valid base64");
            assert_eq!(bytes.len(), LIVE_FRAME_SAMPLES * 2);
            for pair in bytes.chunks_exact(2) {
                let sample = i16::from_le_bytes([pair[0], pair[1]]);
                assert!((sample - f32_to_i16(0.5)).abs() <= 1, "sample={sample}");
            }
        }
        assert!(matches!(rx.try_recv(), Ok(Ev::Level(v)) if v > 0.5));
    }

    #[test]
    fn resamples_48k_to_16k_in_any_chunking() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut whole = Vec::new();
        Resampler::new(48_000).push(&input, &mut whole);
        let mut pieces = Vec::new();
        let mut r = Resampler::new(48_000);
        for c in input.chunks(441) {
            r.push(c, &mut pieces);
        }
        assert!((15_990..=16_000).contains(&whole.len()), "{}", whole.len());
        assert_eq!(whole, pieces);
        // A slow sine survives the box filter almost unchanged.
        assert!((whole[8000] - input[24_000]).abs() < 0.01);
    }

    #[test]
    fn resamples_44k1_and_passes_16k_through() {
        let mut out = Vec::new();
        Resampler::new(44_100).push(&vec![0.5; 44_100], &mut out);
        assert!((15_990..=16_000).contains(&out.len()), "{}", out.len());
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        let mut same = Vec::new();
        Resampler::new(16_000).push(&[0.1, 0.2, 0.3], &mut same);
        assert_eq!(same, vec![0.1, 0.2, 0.3]);
    }

    // Each failure gets the reason the user is told; glitches must not end a take ("I can't find a microphone").
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn mic_errors_get_a_reason_and_glitches_are_ignored() {
        use cpal::{Error, ErrorKind};
        for kind in [ErrorKind::Xrun, ErrorKind::RealtimeDenied, ErrorKind::DeviceChanged] {
            assert_eq!(mic_problem(&kind.into(), false), None, "{kind:?} mid-take is a glitch");
        }
        let reason = |e: Error, opening| mic_problem(&e, opening).map(|p| p.reason);
        assert_eq!(reason(ErrorKind::DeviceBusy.into(), true), Some("busy"));
        assert_eq!(reason(ErrorKind::PermissionDenied.into(), true), Some("blocked"));
        // How cpal words E_ACCESSDENIED from WASAPI (an io::Error from the HRESULT).
        let denied = std::io::Error::from_raw_os_error(0x8007_0005_u32 as i32).to_string();
        assert_eq!(reason(Error::with_message(ErrorKind::BackendError, denied), true), Some("blocked"));
        assert_eq!(reason(ErrorKind::DeviceNotAvailable.into(), true), Some("missing"));
        assert_eq!(reason(ErrorKind::DeviceNotAvailable.into(), false), Some("lost"), "unplugged mid-take");
        assert_eq!(reason(ErrorKind::StreamInvalidated.into(), false), Some("lost"));
        let other = mic_problem(&Error::with_message(ErrorKind::BackendError, "boom"), true).expect("a failure");
        assert_eq!((other.reason, other.detail.as_str()), ("failed", "boom"));
        assert_eq!(open_failed(ErrorKind::Xrun.into()).reason, "failed", "nothing that stops opening is ignored");
    }
}
