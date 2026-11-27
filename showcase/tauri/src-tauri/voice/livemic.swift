// Live mode (a Gemini Live call): the mic goes out as raw audio instead of to the recogniser. While a call is open
// ({"cmd":"live_capture","on":true}) the mic streams {"type":"pcm","data":<base64>} lines: 16 kHz, 16-bit
// little-endian, mono. Apple's voice processing (echo cancellation) is on for this mic only, so Jarvis's own voice
// from the speakers doesn't count as you cutting in. Takes and the wake word never use it.
import AVFoundation
import CoreAudio
import Foundation

/// Converts mic buffers (any rate, float, any channel count) to the Live call's 16 kHz 16-bit mono PCM.
final class LivePCM {
    static let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter
    private let mono: AVAudioFormat

    init?(from input: AVAudioFormat) {
        // The channels are averaged here, not by the converter: mics report a discrete layout (the built-in one 3
        // channels, 9 with voice processing on) and AVAudioConverter's downmix turns that into silence.
        guard input.commonFormat == .pcmFormatFloat32, !input.isInterleaved || input.channelCount == 1,
              let m = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, channels: 1, interleaved: false),
              let c = AVAudioConverter(from: m, to: Self.format) else { return nil }
        mono = m
        converter = c
    }

    /// The buffer's channels averaged into one.
    private func mixed(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let n = Int(buffer.format.channelCount), frames = Int(buffer.frameLength)
        guard let src = buffer.floatChannelData, let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let dst = out.floatChannelData?[0] else { return nil }
        out.frameLength = buffer.frameLength
        for i in 0 ..< frames {
            var sum: Float = 0
            for c in 0 ..< n { sum += src[c][i] }
            dst[i] = sum / Float(n)
        }
        return out
    }

    /// One mic buffer in, its PCM bytes out (the resampler may hold a few samples back for the next buffer).
    func convert(_ buffer: AVAudioPCMBuffer) -> Data {
        let room = AVAudioFrameCount(Double(buffer.frameLength) * Self.format.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: room) else { return Data() }
        guard let one = mixed(buffer) else { return Data() }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return one
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return Data() }
        return Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    static func message(_ pcm: Data) -> [String: Any] { ["type": "pcm", "data": pcm.base64EncodedString()] }
}

/// The Live call's mic: its own engine with voice processing, closed when the call ends so takes get a plain one back.
final class LiveMic {
    private var engine: AVAudioEngine?
    var running: Bool { engine != nil }

    enum Access { case open, ask, refused }
    /// What the call does with the mic permission it finds.
    static func access(_ status: AVAuthorizationStatus) -> Access {
        switch status {
        case .authorized: return .open
        // Never asked, or an update re-signed ad hoc so the old grant no longer matches (macOS reports that as
        // never asked while Settings still shows Jarvis on): ask, which shows the prompt and grants this build.
        case .notDetermined: return .ask
        default: return .refused
        }
    }

    /// Opens the mic (the picked one, else the usual fallbacks). Returns why it couldn't, or nil once it streams.
    func start() -> String? {
        if engine != nil { return nil }
        var problem = "no mic"
        for dev in InputDevice.tries(picked: InputDevice.picked(), current: InputDevice.current(), builtIn: InputDevice.builtIn()) {
            let eng = AVAudioEngine()
            let input = eng.inputNode
            if let dev, !InputDevice.use(dev, on: input) { continue }
            do {
                // Before reading the format: voice processing changes it.
                try input.setVoiceProcessingEnabled(true)
                if #available(macOS 14, *) {
                    // Don't turn down what's playing (Jarvis's own voice comes from the app, not this engine).
                    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch {
                log("live mic: no echo cancellation on device \(dev ?? 0): \(error)")
            }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0, let pcm = LivePCM(from: format) else { continue }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                let data = pcm.convert(buffer)
                if !data.isEmpty { DispatchQueue.main.async { emit(LivePCM.message(data)) } }
            }
            do {
                eng.prepare()
                try eng.start()
                engine = eng
                log("live mic: streaming 16 kHz PCM from \(Int(format.sampleRate)) Hz × \(format.channelCount)")
                return nil
            } catch {
                input.removeTap(onBus: 0)
                problem = "\(error)"
            }
        }
        return problem
    }

    func stop() {
        guard let eng = engine else { return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        try? eng.inputNode.setVoiceProcessingEnabled(false)
        engine = nil
        log("live mic: closed")
    }
}
