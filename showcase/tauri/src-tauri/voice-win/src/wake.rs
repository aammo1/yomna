// The wake phrase, "Hey Yomna": a port of WakeWord in voice/main.swift (keep the two in step). A greeting, then the
// name, at the start of something said (the text's start or after a sentence end). The name can be the user's own
// ("Hey Friday"); the greeting stays, so the name alone in a sentence never wakes it.

const GREETINGS: [&str; 5] = ["hey", "hi", "hay", "heya", "hiya"];
const DEFAULT_NAMES: [&str; 4] = ["yomna", "yumna", "yomnah", "youmna"];

pub struct WakeWord {
    names: Vec<String>,
    /// The chosen name ("Friday"); None for the default, Yomna.
    custom: Option<String>,
}

impl Default for WakeWord {
    fn default() -> Self {
        WakeWord { names: DEFAULT_NAMES.map(String::from).to_vec(), custom: None }
    }
}

/// A word of the text, lowercased without apostrophes ("Friday's" -> "fridays"), and where it sits (byte offsets).
pub struct Token {
    pub word: String,
    pub start: usize,
    pub end: usize,
}

pub struct Scan {
    pub rest: Option<String>,
    pub distance: Option<usize>,
}

impl WakeWord {
    pub fn custom(&self) -> Option<&str> {
        self.custom.as_deref()
    }

    /// Sets the name after the greeting; None, "" or Yomna goes back to Yomna. Letters only, 4 to 20 of them (the
    /// rule in sidecar/wakename.mjs); anything else is refused (returns false) and the name stays as it was.
    pub fn set_name(&mut self, raw: Option<&str>) -> bool {
        let w: String = raw.unwrap_or("").to_lowercase().chars().filter(|c| c.is_alphabetic()).collect();
        if w.is_empty() || DEFAULT_NAMES.contains(&w.as_str()) {
            *self = WakeWord::default();
            return true;
        }
        let n = w.chars().count();
        if !(4..=20).contains(&n) {
            return false;
        }
        let mut cs = w.chars();
        self.custom = cs.next().map(|f| f.to_uppercase().chain(cs).collect());
        self.names = vec![w];
        true
    }

    /// Whether a heard word (within the allowed edits) is shaped like the name: the same first letter, and at most
    /// one letter short. The default, Yomna, follows the same rule as a name of the user's own.
    fn plausible(&self, heard: &str) -> bool {
        self.names.first().is_some_and(|n| heard.chars().next() == n.chars().next() && heard.chars().count() + 1 >= n.chars().count())
    }

    /// Edits allowed for the next word (one fewer for two words joined). A short name must be heard exactly ("Nova"
    /// mustn't take "Nora"); 6 or 7 letters ("Friday") allow one edit, longer ones two.
    fn allowed_edits(&self) -> i64 {
        let n = self.names.first().map_or(0, |n| n.chars().count());
        if n >= 8 {
            2
        } else if n >= 6 {
            1
        } else {
            0
        }
    }

    /// What was said after the phrase ("" if nothing yet), or None when the phrase isn't there.
    pub fn match_rest(&self, text: &str) -> Option<String> {
        self.scan(text).rest
    }

    /// The match, plus the closest name's edit distance after a greeting (None if no greeting).
    pub fn scan(&self, text: &str) -> Scan {
        let words = tokens(text);
        let mut closest: Option<usize> = None;
        for i in 0..words.len().saturating_sub(1) {
            let w = &words[i];
            if !GREETINGS.contains(&w.word.as_str()) {
                continue;
            }
            let before = &text[if i == 0 { 0 } else { words[i - 1].end }..w.start];
            // Up to two stray words may come first ("um", "okay", a cough heard as "the"); live text rarely has a full stop.
            let at_start = i <= 2 || before.contains(['.', '?', '!']);
            // Only spaces or a comma between greeting and name ("Hey, Yomna").
            if !text[w.end..words[i + 1].start].chars().all(|c| c == ' ' || c == ',') {
                continue;
            }
            let mut candidates = vec![(words[i + 1].word.clone(), words[i + 1].end, self.allowed_edits())];
            // Split in two ("Jar vis"): joined, it must be a closer match.
            if i + 2 < words.len() {
                candidates.push((words[i + 1].word.clone() + &words[i + 2].word, words[i + 2].end, self.allowed_edits() - 1));
            }
            for (name, end, allowed) in candidates {
                let d = self.distance(&name);
                closest = Some(closest.map_or(d, |c| c.min(d)));
                if (d as i64) <= allowed && self.plausible(&name) && at_start {
                    let rest = text[end..].trim_start_matches(|c: char| !c.is_alphanumeric());
                    return Scan { rest: Some(rest.trim().to_string()), distance: Some(d) };
                }
            }
        }
        Scan { rest: None, distance: closest }
    }

    fn distance(&self, word: &str) -> usize {
        self.names.iter().map(|n| edits(word, n)).min().unwrap_or(usize::MAX)
    }
}

/// What follows the first n words of the text: the wake phrase as first heard, once a later reading of it no longer
/// matches ("Hey Jervis" revised to "Hey Jer vis"), so it still isn't sent as part of the request.
pub fn dropping(n: usize, text: &str) -> String {
    if n == 0 {
        return text.to_string();
    }
    let words = tokens(text);
    match words.get(n) {
        Some(w) => text[w.start..].trim().to_string(),
        None => String::new(),
    }
}

pub fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let push = |s: usize, e: usize, out: &mut Vec<Token>| {
        let w: String = text[s..e].to_lowercase().chars().filter(|&c| c != '\'' && c != '\u{2019}').collect();
        if !w.is_empty() {
            out.push(Token { word: w, start: s, end: e });
        }
    };
    for (i, c) in text.char_indices() {
        let in_word = c.is_alphanumeric() || ((c == '\'' || c == '\u{2019}') && start.is_some());
        if in_word {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            push(s, i, &mut out);
        }
    }
    if let Some(s) = start {
        push(s, text.len(), &mut out);
    }
    out
}

fn edits(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return a.len().max(b.len());
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = prev.clone();
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases from `voice --test-wake` (voice/main.swift).
    fn check(w: &WakeWord, text: &str, want: Option<&str>) {
        assert_eq!(w.match_rest(text).as_deref(), want, "{text:?}");
    }

    #[test]
    fn the_phrase_and_its_near_misses() {
        let w = WakeWord::default();
        for (text, want) in [
            ("Hey Yomna", Some("")),
            ("Hey Yomna, open Safari.", Some("open Safari.")),
            ("hey yomna open safari", Some("open safari")),
            ("Hey, Yomna.", Some("")),
            ("Hi Yomna what time is it?", Some("what time is it?")),
            ("That's it. Hey Yomna, open Mail", Some("open Mail")),
            ("HEY YOMNA! What's on today?", Some("What's on today?")),
            ("Hey Yomna\u{2019} open notes", Some("open notes")),
            ("Hey Yonna", None),
            ("Hey Yumna, open Mail", Some("open Mail")),
            ("Hey Yomnah!", Some("")),
            ("Hey Jonah", None),
            ("Hey Service", None),
            ("Hey Yona is ready", None),
            ("Yomna is great", None),
            ("I told him hey Yomna", None),
            ("Um hey Yomna, open Mail", Some("open Mail")),
            ("Okay, hi Yomna", Some("")),
            ("The hey Yomna what time is it", Some("what time is it")),
            ("So I said hey Yomna", None),
            ("Hey there", None),
            ("Hey", None),
            ("Hey. Yomna", None),
            ("", None),
        ] {
            check(&w, text, want);
        }
    }

    #[test]
    fn dropping_takes_the_first_words_off() {
        assert_eq!(dropping(2, "Hey Yomna, what time is it?"), "what time is it?");
        assert_eq!(dropping(2, "Hey Yomna"), "");
        assert_eq!(dropping(3, "Um hey Yomna open Mail"), "open Mail");
        assert_eq!(dropping(0, "open Mail"), "open Mail");
    }

    #[test]
    fn a_name_of_the_users_own() {
        let mut w = WakeWord::default();
        assert!(!w.set_name(Some("Bob")));
        assert!(!w.set_name(Some("a really very long name for this")));
        assert!(w.set_name(Some("Friday")));
        assert_eq!(w.custom(), Some("Friday"));
        for (text, want) in [
            ("Hey Friday", Some("")),
            ("Hey Friday, open Safari.", Some("open Safari.")),
            ("hi friday what time is it", Some("what time is it")),
            ("Hey Fryday, open Notes", Some("open Notes")),
            ("Hey Fri day, hello", Some("hello")),
            ("Hey Monday", None),
            ("Hey Yomna", None),
            ("Friday is great", None),
            ("I told him hey Friday", None),
        ] {
            check(&w, text, want);
        }
        assert!(w.set_name(Some("Nova")));
        check(&w, "Hey Nova, play music", Some("play music"));
        check(&w, "Hey Nora", None);
        assert!(w.set_name(Some("Yomna")), "the default's own name");
        assert_eq!(w.custom(), None);
        assert!(w.set_name(Some("")));
        assert_eq!(w.custom(), None);
        check(&w, "Hey Yomna, open Mail", Some("open Mail"));
        check(&w, "Hey Friday", None);
        assert!(w.set_name(None));
    }
}
