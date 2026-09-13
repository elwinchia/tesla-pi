#!/usr/bin/env python3
"""make-karaoke-songs.py — build a public-domain karaoke songbook for the
karaoke addon (see docs/karaoke-addon.md).

Why this exists
---------------
The addon plays UltraStar songs and nothing else: a folder per song holding
timed lyrics with note pitches, plus audio. Sourcing those means someone's
recording and someone's chart — fine for your own library, not something this
repo can ship.

So we synthesise them. Every song here is in the PUBLIC DOMAIN: the melodies
and the words are old enough that nobody owns them, and the audio is generated
on your Pi from the note data below, so the recordings are yours. Nothing is
downloaded and nothing is copied.

What you get per song is what an UltraStar folder wants:

  <Artist> - <Title>/
    <Artist> - <Title>.txt          note chart: pitch + timing per syllable
    <Artist> - <Title>.mp3          the mix (melody over the accompaniment)
    <Artist> - <Title> [VOC].mp3    the melody alone — the guide vocal
    <Artist> - <Title> [INSTR].mp3  the accompaniment alone — sing over this

It is a synthesiser, not a band: a plucked-string-ish melody voice over block
chords derived from the melody itself. It sounds like a cheap keyboard, which
is the point — it keeps time, it holds the tune, and every note lands exactly
where the chart says it does, so the pitch scorer agrees with what you hear.

Usage
-----
  sudo ./scripts/make-karaoke-songs.py                 # all of them
  sudo ./scripts/make-karaoke-songs.py --list          # what's in the book
  sudo ./scripts/make-karaoke-songs.py --only happy-birthday
  ./scripts/make-karaoke-songs.py --dry-run --only twinkle   # chart, no audio
  sudo ./scripts/make-karaoke-songs.py --rescan        # and tell the server

Needs python3 (stdlib only) and, for mp3, ffmpeg. Without ffmpeg it writes
WAV instead and points the chart at those — the browser plays either. Safe to
re-run; it overwrites its own songs and touches nothing else.
"""

import argparse
import math
import os
import subprocess
import sys
import wave
from array import array

SR = 44100

# ---------------------------------------------------------------------------
# The songbook.
#
# Durations are UltraStar beats, where a quarter note is 4 — the same unit the
# chart uses, so what is written here is what is notated. A syllable ending in
# "-" joins the next one into a word ("Hap-" + "py" renders "Happy"), which is
# also how a melisma is written: one word split across the notes it is sung
# over ("ni-" G4, "ght" E4 renders "night" over two pitches).
#
# "pickup" is how many beats sit before the first downbeat; it only shifts the
# bar grid the accompaniment is built on. "transpose" moves the whole song in
# semitones, used to drag a melody into a range an ordinary person can sing.
# ---------------------------------------------------------------------------

SONGS = [
    {
        "id": "happy-birthday",
        "title": "Happy Birthday to You",
        "artist": "Traditional",
        "year": "1893",
        "note": "Melody 'Good Morning to All', Hill sisters 1893. Public domain; "
                "the disputed lyric copyright was struck down in 2016.",
        "bpm": 96, "beats_per_bar": 12, "pickup": 4, "key": "G", "transpose": 0,
        "lines": [
            ["Hap-:D4:2", "py:D4:2", "birth-:E4:4", "day:D4:4", "to:G4:4", "you:F#4:8"],
            ["Hap-:D4:2", "py:D4:2", "birth-:E4:4", "day:D4:4", "to:A4:4", "you:G4:8"],
            ["Hap-:D4:2", "py:D4:2", "birth-:D5:4", "day:B4:4", "dear:G4:4", "bud-:F#4:4", "dy:E4:4"],
            ["Hap-:C5:2", "py:C5:2", "birth-:B4:4", "day:G4:4", "to:A4:4", "you:G4:12"],
        ],
    },
    {
        "id": "twinkle",
        "title": "Twinkle, Twinkle, Little Star",
        "artist": "Traditional",
        "year": "1806",
        "note": "Jane Taylor's poem 1806, to the French tune 'Ah! vous dirai-je, maman'.",
        "bpm": 100, "beats_per_bar": 16, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Twin-:C4:4", "kle:C4:4", "twin-:G4:4", "kle:G4:4", "lit-:A4:4", "tle:A4:4", "star:G4:8"],
            ["How:F4:4", "I:F4:4", "won-:E4:4", "der:E4:4", "what:D4:4", "you:D4:4", "are:C4:8"],
            ["Up:G4:4", "a-:G4:4", "bove:F4:4", "the:F4:4", "world:E4:4", "so:E4:4", "high:D4:8"],
            ["Like:G4:4", "a:G4:4", "dia-:F4:4", "mond:F4:4", "in:E4:4", "the:E4:4", "sky:D4:8"],
            ["Twin-:C4:4", "kle:C4:4", "twin-:G4:4", "kle:G4:4", "lit-:A4:4", "tle:A4:4", "star:G4:8"],
            ["How:F4:4", "I:F4:4", "won-:E4:4", "der:E4:4", "what:D4:4", "you:D4:4", "are:C4:16"],
        ],
    },
    {
        "id": "ode-to-joy",
        "title": "Ode to Joy",
        "artist": "Beethoven",
        "year": "1824",
        "note": "Beethoven's Ninth, 1824. English words by Henry van Dyke, 1907.",
        "bpm": 108, "beats_per_bar": 16, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Joy-:E4:4", "ful:E4:4", "joy-:F4:4", "ful:G4:4", "we:G4:4", "a-:F4:4", "dore:E4:4", "thee:D4:4"],
            ["God:C4:4", "of:C4:4", "glo-:D4:4", "ry:E4:4", "Lord:E4:6", "of:D4:2", "love:D4:8"],
            ["Hearts:E4:4", "un-:E4:4", "fold:F4:4", "like:G4:4", "flow'rs:G4:4", "be-:F4:4", "fore:E4:4", "thee:D4:4"],
            ["O-:C4:4", "p'ning:C4:4", "to:D4:4", "the:E4:4", "sun:D4:6", "a-:C4:2", "bove:C4:8"],
        ],
    },
    {
        "id": "jingle-bells",
        "title": "Jingle Bells",
        "artist": "James Lord Pierpont",
        "year": "1857",
        "note": "Published 1857 as 'One Horse Open Sleigh'. The chorus.",
        "bpm": 120, "beats_per_bar": 16, "pickup": 0, "key": "G", "transpose": 0,
        "lines": [
            ["Jin-:B4:4", "gle:B4:4", "bells:B4:8", "jin-:B4:4", "gle:B4:4", "bells:B4:8"],
            ["Jin-:B4:4", "gle:D5:4", "all:G4:6", "the:A4:2", "way:B4:16"],
            ["Oh:C5:2", "what:C5:2", "fun:C5:2", "it:C5:2", "is:C5:2", "to:B4:2", "ride:B4:4",
             "in:B4:2", "a:B4:2", "one:A4:2", "horse:A4:2", "o-:B4:2", "pen:A4:2", "sleigh:D5:20"],
            ["Jin-:B4:4", "gle:B4:4", "bells:B4:8", "jin-:B4:4", "gle:B4:4", "bells:B4:8"],
            ["Jin-:B4:4", "gle:D5:4", "all:G4:6", "the:A4:2", "way:B4:16"],
            ["Oh:C5:2", "what:C5:2", "fun:C5:2", "it:C5:2", "is:C5:2", "to:B4:2", "ride:B4:4",
             "in:B4:2", "a:B4:2", "one:D5:2", "horse:D5:2", "o-:C5:2", "pen:A4:2", "sleigh:G4:20"],
        ],
    },
    {
        "id": "mary-lamb",
        "title": "Mary Had a Little Lamb",
        "artist": "Traditional",
        "year": "1830",
        "note": "Sarah Josepha Hale's poem, 1830.",
        "bpm": 100, "beats_per_bar": 16, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Ma-:E4:4", "ry:D4:4", "had:C4:4", "a:D4:4", "lit-:E4:4", "tle:E4:4", "lamb:E4:8"],
            ["lit-:D4:4", "tle:D4:4", "lamb:D4:8", "lit-:E4:4", "tle:G4:4", "lamb:G4:8"],
            ["Ma-:E4:4", "ry:D4:4", "had:C4:4", "a:D4:4", "lit-:E4:4", "tle:E4:4", "lamb:E4:4", "its:E4:4"],
            ["fleece:D4:4", "was:D4:4", "white:E4:4", "as:D4:4", "snow:C4:16"],
        ],
    },
    {
        "id": "row-your-boat",
        "title": "Row, Row, Row Your Boat",
        "artist": "Traditional",
        "year": "1852",
        "note": "First printed 1852. A round — try it in two halves.",
        "bpm": 138, "beats_per_bar": 12, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Row:C4:6", "row:C4:6", "row:C4:4", "your:D4:2", "boat:E4:6"],
            ["gent-:E4:4", "ly:D4:2", "down:E4:4", "the:F4:2", "stream:G4:12"],
            ["Mer-:C5:2", "ri-:C5:2", "ly:C5:2", "mer-:G4:2", "ri-:G4:2", "ly:G4:2",
             "mer-:E4:2", "ri-:E4:2", "ly:E4:2", "mer-:C4:2", "ri-:C4:2", "ly:C4:2"],
            ["Life:G4:4", "is:F4:2", "but:E4:4", "a:D4:2", "dream:C4:12"],
        ],
    },
    {
        "id": "london-bridge",
        "title": "London Bridge Is Falling Down",
        "artist": "Traditional",
        "year": "1744",
        "note": "Printed in Tommy Thumb's Pretty Song Book, c. 1744.",
        "bpm": 104, "beats_per_bar": 16, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Lon-:G4:4", "don:A4:4", "Bridge:G4:4", "is:F4:4", "fall-:E4:4", "ing:F4:4", "down:G4:8"],
            ["fall-:D4:4", "ing:E4:4", "down:F4:8", "fall-:E4:4", "ing:F4:4", "down:G4:8"],
            ["Lon-:G4:4", "don:A4:4", "Bridge:G4:4", "is:F4:4", "fall-:E4:4", "ing:F4:4", "down:G4:8"],
            ["my:D4:4", "fair:G4:4", "la-:E4:4", "dy:C4:20"],
        ],
    },
    {
        "id": "are-you-sleeping",
        "title": "Are You Sleeping",
        "artist": "Traditional",
        "year": "1780",
        "note": "'Frere Jacques', first printed c. 1780. Also a four-part round.",
        "bpm": 112, "beats_per_bar": 16, "pickup": 0, "key": "F", "transpose": 0,
        "lines": [
            ["Are:F4:4", "you:G4:4", "sleep-:A4:4", "ing:F4:4", "are:F4:4", "you:G4:4", "sleep-:A4:4", "ing:F4:4"],
            ["Broth-:A4:4", "er:Bb4:4", "John:C5:8", "broth-:A4:4", "er:Bb4:4", "John:C5:8"],
            ["Morn-:C5:2", "ing:D5:2", "bells:C5:2", "are:Bb4:2", "ring-:A4:4", "ing:F4:4",
             "morn-:C5:2", "ing:D5:2", "bells:C5:2", "are:Bb4:2", "ring-:A4:4", "ing:F4:4"],
            ["Ding:F4:4", "dang:C4:4", "dong:F4:8", "ding:F4:4", "dang:C4:4", "dong:F4:8"],
        ],
    },
    {
        "id": "old-macdonald",
        "title": "Old MacDonald Had a Farm",
        "artist": "Traditional",
        "year": "1917",
        "note": "Collected 1917; the tune is older. Public domain.",
        "bpm": 112, "beats_per_bar": 16, "pickup": 0, "key": "G", "transpose": 0,
        "lines": [
            ["Old:G4:4", "Mac-:G4:4", "Don-:G4:4", "ald:D4:4", "had:E4:4", "a:E4:4", "farm:D4:8"],
            ["E:B4:4", "I:B4:4", "E:A4:4", "I:A4:4", "O:G4:16"],
            ["And:G4:4", "on:G4:4", "that:G4:4", "farm:D4:4", "he:E4:4", "had:E4:4", "a:D4:4", "cow:D4:4"],
            ["E:B4:4", "I:B4:4", "E:A4:4", "I:A4:4", "O:G4:16"],
            ["With:D4:2", "a:D4:2", "moo:G4:2", "moo:G4:2", "here:G4:4",
             "and:D4:2", "a:D4:2", "moo:G4:2", "moo:G4:2", "there:G4:12"],
            ["Here:G4:2", "a:G4:2", "moo:G4:4", "there:G4:2", "a:G4:2", "moo:G4:4",
             "ev-:G4:2", "'ry-:G4:2", "where:G4:2", "a:G4:2", "moo:G4:4", "moo:G4:4"],
            ["Old:G4:4", "Mac-:G4:4", "Don-:G4:4", "ald:D4:4", "had:E4:4", "a:E4:4", "farm:D4:8"],
            ["E:B4:4", "I:B4:4", "E:A4:4", "I:A4:4", "O:G4:16"],
        ],
    },
    {
        "id": "when-the-saints",
        "title": "When the Saints Go Marching In",
        "artist": "Traditional",
        "year": "1896",
        "note": "Traditional spiritual, published 1896.",
        "bpm": 116, "beats_per_bar": 16, "pickup": 0, "key": "C", "transpose": 0,
        "lines": [
            ["Oh:C4:4", "when:E4:4", "the:F4:4", "saints:G4:20", "go:C4:4", "march-:E4:4", "ing:F4:4", "in:G4:20"],
            ["Oh:C4:4", "when:E4:4", "the:F4:4", "saints:G4:8", "go:E4:8", "march-:C4:4", "ing:E4:4", "in:D4:28"],
            ["Oh:E4:4", "Lord:E4:4", "I:D4:8", "want:C4:8", "to:E4:8", "be:G4:8", "in:G4:4", "that:G4:4", "num-:F4:8", "ber:F4:8"],
            ["when:E4:4", "the:F4:4", "saints:G4:8", "go:E4:8", "march-:C4:8", "ing:D4:8", "in:C4:24"],
        ],
    },
    {
        "id": "we-wish-you",
        "title": "We Wish You a Merry Christmas",
        "artist": "Traditional",
        "year": "1935",
        "note": "English carol, traditional. Public domain.",
        "bpm": 108, "beats_per_bar": 12, "pickup": 4, "key": "F", "transpose": 0,
        "lines": [
            ["We:C4:4", "wish:F4:4", "you:F4:2", "a:G4:2", "mer-:F4:2", "ry:E4:2", "Christ-:D4:4", "mas:D4:4"],
            ["we:D4:4", "wish:G4:4", "you:G4:2", "a:A4:2", "mer-:G4:2", "ry:F4:2", "Christ-:E4:4", "mas:C4:4"],
            ["we:C4:4", "wish:A4:4", "you:A4:2", "a:Bb4:2", "mer-:A4:2", "ry:G4:2", "Christ-:F4:4", "mas:D4:4"],
            ["and:C4:4", "a:D4:4", "hap-:D4:4", "py:G4:4", "new:E4:4", "year:F4:12"],
        ],
    },
    {
        "id": "silent-night",
        "title": "Silent Night",
        "artist": "Franz Gruber",
        "year": "1818",
        "note": "Gruber/Mohr 1818; John Freeman Young's English text, 1859. "
                "Written out in C and dropped to A so the top note stays singable.",
        "bpm": 70, "beats_per_bar": 12, "pickup": 0, "key": "C", "transpose": -3,
        "lines": [
            ["Si-:G4:6", "lent:A4:2", "ni-:G4:4", "ght:E4:12"],
            ["ho-:G4:6", "ly:A4:2", "ni-:G4:4", "ght:E4:12"],
            ["All:D5:8", "is:D5:4", "calm:B4:12"],
            ["all:C5:8", "is:C5:4", "bright:G4:12"],
            ["Round:A4:8", "yon:A4:4", "vir-:C5:6", "gin:B4:2", "mo-:A4:4", "ther:G4:6", "and:A4:2", "chi-:G4:4", "ld:E4:12"],
            ["Ho-:A4:8", "ly:A4:4", "in-:C5:6", "fant:B4:2", "so:A4:4", "ten-:G4:6", "der:A4:2", "and:G4:4", "mild:E4:12"],
            ["Sleep:D5:8", "in:D5:4", "heav-:F5:6", "en-:D5:2", "ly:B4:4", "peace:C5:12"],
            ["Sleep:E5:12", "in:C5:6", "hea-:G4:2", "ven-:E4:4", "ly:G4:6", "pe-:F4:2", "a-:D4:4", "ce:C4:12"],
        ],
    },
]

# ---------------------------------------------------------------------------
# Notes and chords
# ---------------------------------------------------------------------------

STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def parse_note(name):
    """'F#4' -> MIDI number. C4 is 60."""
    i = 0
    if name[i] not in STEPS:
        raise ValueError("bad note %r" % name)
    semi = STEPS[name[i]]
    i += 1
    while i < len(name) and name[i] in "#b":
        semi += 1 if name[i] == "#" else -1
        i += 1
    return (int(name[i:]) + 1) * 12 + semi


def freq_of(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


# Diatonic triads of a major key: semitones above the tonic, minor?, and how
# much the ear expects it. Only the six that carry these tunes; the diminished
# vii is never the answer. The priors do real work — a bar of E-D-D scores
# almost the same under vi and V, and V is what the song means.
DEGREES = [(0, False, 1.35), (2, True, 0.80), (4, True, 0.62),
           (5, False, 1.10), (7, False, 1.10), (9, True, 0.85)]

# What a note is worth to a chord that contains it, and costs to one that does
# not. The penalty is deliberately mild: passing notes are normal, and a chord
# that flinches at every one of them ends up chasing the melody bar by bar.
W_ROOT, W_THIRD, W_FIFTH, W_OUTSIDE = 1.0, 0.8, 0.9, -0.55
DOWNBEAT = 1.3      # the note on the barline decides more than the rest
STAY = 1.05         # mild pull towards not changing chord


def build_events(song):
    """Flatten the lines into (start, length, midi, text) plus line breaks."""
    events, breaks, t = [], [], 0
    for li, line in enumerate(song["lines"]):
        if li:
            breaks.append(t)
        for tok in line:
            text, note, beats = tok.rsplit(":", 2)
            beats = int(beats)
            midi = parse_note(note) + song.get("transpose", 0)
            events.append((t, beats, midi, text))
            t += beats
    return events, breaks, t


def derive_chords(events, song, total):
    """Pick one chord per bar by asking which triad the bar's notes sit in.

    These are folk tunes over I/IV/V with the odd relative minor, so scoring
    each candidate by how much of the bar's singing time it accounts for gets
    it right nearly always — and being wrong costs a slightly odd chord, not a
    broken song. First and last bar are forced home to the tonic.
    """
    bpb = song["beats_per_bar"]
    pickup = song.get("pickup", 0)
    tonic = (parse_note(song["key"] + "4") + song.get("transpose", 0)) % 12

    # The grid hangs off the first downbeat, not off t=0: with a pickup, bar
    # one starts after it, and the pickup notes belong to the bar before.
    start = pickup - bpb if pickup else 0
    bars = []
    while start < total:
        bars.append((start, start + bpb))
        start += bpb

    chords = []
    prev = None
    for bi, (b0, b1) in enumerate(bars):
        best, best_score = None, None
        for offset, minor, prior in DEGREES:
            root = (tonic + offset) % 12
            third = (root + (3 if minor else 4)) % 12
            fifth = (root + 7) % 12
            score = 0.0
            for (t, dur, midi, _text) in events:
                overlap = min(t + dur, b1) - max(t, b0)
                if overlap <= 0:
                    continue
                if t <= b0 < t + dur:
                    overlap *= DOWNBEAT
                pc = midi % 12
                if pc == root:
                    score += overlap * W_ROOT
                elif pc == fifth:
                    score += overlap * W_FIFTH
                elif pc == third:
                    score += overlap * W_THIRD
                else:
                    score += overlap * W_OUTSIDE
            score *= prior
            if prev == (root, minor):
                score *= STAY
            if best_score is None or score > best_score:
                best, best_score = (root, minor), score
        if bi == 0 or bi == len(bars) - 1:
            best = (tonic, False)
        prev = best
        chords.append((b0, b1, best[0], best[1]))
    return chords


# ---------------------------------------------------------------------------
# Synthesis
#
# A wavetable rather than sin() per sample: this runs on a Pi 4 in Python with
# no numpy, and a table lookup is the difference between a minute a song and
# ten. The table is one cycle of a harmonic stack, so the timbre costs nothing
# at render time.
# ---------------------------------------------------------------------------

TABLE_BITS = 11
TABLE_SIZE = 1 << TABLE_BITS
TABLE_MASK = TABLE_SIZE - 1


def make_table(harmonics):
    tbl = [0.0] * TABLE_SIZE
    for mult, amp in harmonics:
        w = 2.0 * math.pi * mult / TABLE_SIZE
        for i in range(TABLE_SIZE):
            tbl[i] += amp * math.sin(w * i)
    peak = max(abs(v) for v in tbl) or 1.0
    return [v / peak for v in tbl]


LEAD = make_table([(1, 1.0), (2, 0.38), (3, 0.20), (4, 0.09), (5, 0.04)])
PAD = make_table([(1, 1.0), (2, 0.22), (3, 0.08)])
BASS = make_table([(1, 1.0), (2, 0.30), (3, 0.10)])
TICK = make_table([(1, 1.0), (3, 0.5), (7, 0.25)])


def add_tone(buf, table, start_s, dur_s, midi, amp,
             attack=0.012, release=0.09, sustain=0.72):
    """Mix one note into buf. Straight-line ADSR; nothing fancy survives the
    Tesla's speakers anyway."""
    i0 = int(start_s * SR)
    n = int(dur_s * SR)
    if n <= 0 or i0 >= len(buf):
        return
    n = min(n, len(buf) - i0)
    a = min(int(attack * SR), n)
    r = min(int(release * SR), n - a)
    body = n - a - r
    inc = freq_of(midi) * TABLE_SIZE / SR
    phase = 0.0
    idx = i0
    for i in range(a):
        buf[idx] += table[int(phase) & TABLE_MASK] * amp * (i / a)
        phase += inc
        idx += 1
    if body > 0:
        drop = (1.0 - sustain) / body
        env = 1.0
        for _ in range(body):
            buf[idx] += table[int(phase) & TABLE_MASK] * amp * env
            env -= drop
            phase += inc
            idx += 1
    for i in range(r):
        buf[idx] += table[int(phase) & TABLE_MASK] * amp * sustain * (1.0 - i / r)
        phase += inc
        idx += 1


def render(song, events, chords, total):
    beat_s = 60.0 / (song["bpm"] * 4)
    bpb = song["beats_per_bar"]
    gap_s = bpb * beat_s                     # one bar of count-in
    total_s = gap_s + total * beat_s + 1.6
    n = int(total_s * SR)
    melody = array("d", bytes(8 * n))
    backing = array("d", bytes(8 * n))

    def at(beat):
        return gap_s + beat * beat_s

    for (t, dur, midi, _text) in events:
        add_tone(melody, LEAD, at(t), dur * beat_s * 0.97, midi, 0.34)

    # Accompaniment: root in the bass on the strong beats, the triad struck on
    # every quarter. A pulse to sing against, quiet enough to sing over.
    for (b0, b1, root, minor) in chords:
        third = root + (3 if minor else 4)
        voices = [48 + root, 48 + third, 48 + root + 7]
        while max(voices) > 67:              # keep the pad under the melody
            voices = [v - 12 for v in voices]
        beat = b0
        strong = 0
        while beat < b1:
            if beat >= -bpb:
                for v in voices:
                    add_tone(backing, PAD, at(beat), 4 * beat_s * 0.9, v, 0.085,
                             attack=0.02, release=0.12, sustain=0.55)
                if strong == 0 or (bpb == 16 and strong == 2):
                    add_tone(backing, BASS, at(beat), 4 * beat_s * 0.85,
                             36 + root, 0.16, attack=0.006, release=0.08, sustain=0.5)
            beat += 4
            strong += 1

    # Count-in over the lead-in bar, so the first entry is not a guess.
    for k in range(bpb // 4):
        add_tone(backing, TICK, k * 4 * beat_s, 0.05,
                 parse_note("C6" if k == 0 else "G5"), 0.20,
                 attack=0.002, release=0.03, sustain=0.3)

    return melody, backing, gap_s


PEAK = 0.89     # leave a little headroom for the mp3 encoder to overshoot into


def write_wav(path, *bufs):
    """Sum the buffers and normalise. Normalising each file on its own is what
    makes the backing track usable: unscaled it lands about 9 dB under the
    melody, which is right in a mix and far too quiet on its own in a car."""
    n = min(len(b) for b in bufs)
    peak = 0.0
    for i in range(n):
        v = 0.0
        for b in bufs:
            v += b[i]
        if v < 0.0:
            v = -v
        if v > peak:
            peak = v
    gain = (PEAK / peak) if peak > 1e-6 else 1.0
    gain *= 32767.0
    out = array("h", bytes(2 * n))
    for i in range(n):
        v = 0.0
        for b in bufs:
            v += b[i]
        v *= gain
        if v > 32767.0:
            v = 32767.0
        elif v < -32767.0:
            v = -32767.0
        out[i] = int(v)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(out.tobytes())


def to_mp3(wav_path, mp3_path):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav_path,
                    "-codec:a", "libmp3lame", "-q:a", "4", mp3_path],
                   check=True)


# ---------------------------------------------------------------------------
# Chart
# ---------------------------------------------------------------------------

def write_txt(path, song, events, breaks, names, gap_s):
    lines = [
        "#TITLE:%s" % song["title"],
        "#ARTIST:%s" % song["artist"],
        "#LANGUAGE:English",
        "#YEAR:%s" % song["year"],
        "#GENRE:Traditional",
        "#EDITION:tesla-pi public-domain songbook",
        "#CREATOR:scripts/make-karaoke-songs.py",
        "#MP3:%s" % names["mix"],
        "#AUDIO:%s" % names["mix"],
        "#VOCALS:%s" % names["voc"],
        "#INSTRUMENTAL:%s" % names["instr"],
        "#BPM:%d" % song["bpm"],
        "#GAP:%d" % round(gap_s * 1000),
    ]
    brk = list(breaks)
    for (t, dur, midi, text) in events:
        while brk and brk[0] <= t:
            lines.append("- %d" % brk.pop(0))
        body = text[:-1] if text.endswith("-") else text + " "
        lines.append(": %d %d %d %s" % (t, dur, midi - 60, body))
    lines.append("E")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------

def chown_like(path, ref):
    try:
        st = os.stat(ref)
    except OSError:
        return
    try:
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                os.chown(os.path.join(root, name), st.st_uid, st.st_gid)
        os.chown(path, st.st_uid, st.st_gid)
    except (OSError, PermissionError):
        pass


def build(song, songs_dir, fmt, dry_run, quiet):
    events, breaks, total = build_events(song)
    chords = derive_chords(events, song, total)
    base = "%s - %s" % (song["artist"], song["title"])
    beat_s = 60.0 / (song["bpm"] * 4)

    if dry_run:
        print("=== %s  (%s, %d notes, %.1fs) ===" % (base, song["key"], len(events),
                                                     total * beat_s))
        words = []
        for (_t, _d, _m, text) in events:
            words.append(text[:-1] if text.endswith("-") else text + " ")
        print("  " + "".join(words).strip())
        print("  chords: " + " ".join(
            "%s%s" % (["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][r],
                      "m" if m else "") for (_a, _b, r, m) in chords))
        return None

    stems = {"mix": base, "voc": "%s [VOC]" % base, "instr": "%s [INSTR]" % base}
    folder = os.path.join(songs_dir, base)
    os.makedirs(folder, exist_ok=True)

    if not quiet:
        print("  %-46s %2d bars  %4.1fs" % (base, len(chords), total * beat_s))
    melody, backing, gap_s = render(song, events, chords, total)

    wavs = {}
    for key, bufs in (("voc", (melody,)), ("instr", (backing,)), ("mix", (melody, backing))):
        wavs[key] = os.path.join(folder, stems[key] + ".wav")
        write_wav(wavs[key], *bufs)

    # Encode all three before deleting any WAV. Half a song in mp3 and half in
    # WAV would leave the chart pointing at files that are not there, so a
    # failed encode falls the whole song back rather than splitting it.
    ext = "wav"
    if fmt == "mp3":
        try:
            for key, wav in wavs.items():
                to_mp3(wav, os.path.join(folder, stems[key] + ".mp3"))
            ext = "mp3"
        except (subprocess.CalledProcessError, OSError) as e:
            print("  ffmpeg failed on %s (%s) — keeping WAV" % (base, e), file=sys.stderr)
            for key in wavs:
                mp3 = os.path.join(folder, stems[key] + ".mp3")
                if os.path.exists(mp3):
                    os.unlink(mp3)
        else:
            for wav in wavs.values():
                os.unlink(wav)

    names = {k: "%s.%s" % (v, ext) for k, v in stems.items()}
    write_txt(os.path.join(folder, "%s.txt" % base), song, events, breaks, names, gap_s)
    chown_like(folder, songs_dir)
    return folder


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("songs_dir", nargs="?", default="/var/lib/nightingale/songs")
    ap.add_argument("--only", action="append", metavar="ID",
                    help="build just this song (repeatable); see --list")
    ap.add_argument("--list", action="store_true", help="list the songbook and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="print each chart and its chords; write nothing")
    ap.add_argument("--rescan", action="store_true",
                    help="ask a running nightingale to pick the songs up")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if args.list:
        for s in SONGS:
            print("%-18s %-34s %-22s %s" % (s["id"], s["title"], s["artist"], s["note"]))
        return 0

    chosen = SONGS
    if args.only:
        ids = set(args.only)
        chosen = [s for s in SONGS if s["id"] in ids]
        missing = ids - {s["id"] for s in chosen}
        if missing:
            print("unknown song(s): %s (try --list)" % ", ".join(sorted(missing)),
                  file=sys.stderr)
            return 2

    fmt = "wav"
    if args.dry_run:
        fmt = None
    else:
        from shutil import which
        if which("ffmpeg"):
            fmt = "mp3"
        else:
            print("ffmpeg not found — writing WAV instead (larger, plays fine)")
        os.makedirs(args.songs_dir, exist_ok=True)

    if not args.dry_run and not args.quiet:
        print("=== %s ===" % args.songs_dir)

    built = 0
    for song in chosen:
        if build(song, args.songs_dir, fmt, args.dry_run, args.quiet):
            built += 1

    if args.dry_run:
        return 0

    if not args.quiet:
        print("\n=== %d song%s ===" % (built, "" if built == 1 else "s"))
    if args.rescan:
        import urllib.request
        req = urllib.request.Request(
            "http://127.0.0.1:8088/api/cmd/trigger_scan", data=b"{}",
            headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                print("rescan: HTTP %d" % r.status)
        except Exception as e:                                  # noqa: BLE001
            print("rescan failed (is nightingale running?): %s" % e, file=sys.stderr)
            return 1
    elif not args.quiet:
        # A restart will NOT pick these up: the server pins the library folder
        # on startup and skips the scan when the path has not changed.
        print("Now tell the server to scan (a restart will not do it):")
        print("  curl -sS -X POST http://127.0.0.1:8088/api/cmd/trigger_scan \\")
        print("       -H 'content-type: application/json' -d '{}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
