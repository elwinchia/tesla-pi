#!/bin/bash
# make-karaoke-testsong.sh — build a synthetic UltraStar song for smoke-testing
# the karaoke addon.
#
# Why synthesise one: the addon only supports UltraStar songs (see
# docs/karaoke-addon.md), and a real one means someone's recording plus a
# community-made note chart — fine for your own library, wrong for a test
# fixture committed to a repo. This generates a plain major scale from sine
# tones, so it is ours to ship, tiny, and — because each tone sits exactly on
# the pitch the .txt notates — it actually proves the scorer works rather than
# just proving a file parses.
#
# Sing (or hum, or play) along with the tones and the score should climb. Silence
# should score zero. That is the whole test.
#
# Usage:
#   sudo ./scripts/make-karaoke-testsong.sh [songs-dir]
# Defaults to /var/lib/nightingale/songs. Needs ffmpeg. Idempotent.

set -euo pipefail

SONGS_DIR="${1:-/var/lib/nightingale/songs}"
NAME="Tesla-Pi Test - Scale"
DIR="$SONGS_DIR/$NAME"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }

# UltraStar timing: #BPM counts quarter notes and a *note beat* is 1/4 of one,
# so seconds-per-beat = 60/(BPM*4). At 100 BPM a beat is 0.15 s and our 4-beat
# notes are 0.6 s each. GAP is a flat lead-in in milliseconds.
BPM=100
GAP_MS=1000
BEAT_S=0.15
NOTE_BEATS=4

# A C-major scale. UltraStar pitch 0 is C4 (MIDI 60), so freq = 440*2^((60+p-69)/12).
PITCHES=(0 2 4 5 7 9 11 12)
SYLLABLES=(Do Re Mi Fa Sol La Ti Do)

echo "=== $DIR ==="
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

note_dur="$(awk -v b="$BEAT_S" -v n="$NOTE_BEATS" 'BEGIN{printf "%.3f", b*n}')"
lead_s="$(awk -v g="$GAP_MS" 'BEGIN{printf "%.3f", g/1000}')"

echo "=== rendering ${#PITCHES[@]} tones (${note_dur}s each) ==="
: > "$TMP/voc.list"
: > "$TMP/inst.list"
# Lead-in silence so the first note lands exactly on #GAP.
ffmpeg -v error -f lavfi -i "anullsrc=r=44100:cl=mono" -t "$lead_s" "$TMP/lead.wav" -y
echo "file '$TMP/lead.wav'" >> "$TMP/voc.list"
echo "file '$TMP/lead.wav'" >> "$TMP/inst.list"

for i in "${!PITCHES[@]}"; do
    p="${PITCHES[$i]}"
    f="$(awk -v p="$p" 'BEGIN{printf "%.4f", 440*(2^((60+p-69)/12))}')"
    # Melody: the note itself, with a short fade so the steps do not click.
    ffmpeg -v error -f lavfi -i "sine=frequency=$f:duration=$note_dur:sample_rate=44100" \
        -af "afade=t=in:d=0.02,afade=t=out:st=$(awk -v d="$note_dur" 'BEGIN{printf "%.3f", d-0.05}'):d=0.05,volume=0.5" \
        "$TMP/voc_$i.wav" -y
    echo "file '$TMP/voc_$i.wav'" >> "$TMP/voc.list"
    # Backing: a quiet root drone two octaves down — audibly a different track,
    # and low enough that it cannot be mistaken for the melody by the scorer.
    ffmpeg -v error -f lavfi -i "sine=frequency=130.81:duration=$note_dur:sample_rate=44100" \
        -af "volume=0.12" "$TMP/inst_$i.wav" -y
    echo "file '$TMP/inst_$i.wav'" >> "$TMP/inst.list"
done

echo "=== encoding tracks ==="
ffmpeg -v error -f concat -safe 0 -i "$TMP/voc.list"  -codec:a libmp3lame -q:a 4 "$DIR/$NAME [VOC].mp3" -y
ffmpeg -v error -f concat -safe 0 -i "$TMP/inst.list" -codec:a libmp3lame -q:a 4 "$DIR/$NAME [INSTR].mp3" -y
# The full mix is what plays if a player ignores the stem tags.
ffmpeg -v error -i "$DIR/$NAME [VOC].mp3" -i "$DIR/$NAME [INSTR].mp3" \
    -filter_complex amix=inputs=2:duration=longest:dropout_transition=0 \
    -codec:a libmp3lame -q:a 4 "$DIR/$NAME.mp3" -y

echo "=== writing the note chart ==="
{
    echo "#TITLE:Scale Test"
    echo "#ARTIST:Tesla-Pi"
    echo "#LANGUAGE:English"
    echo "#EDITION:tesla-pi test fixture"
    echo "#MP3:$NAME.mp3"
    echo "#VOCALS:$NAME [VOC].mp3"
    echo "#INSTRUMENTAL:$NAME [INSTR].mp3"
    echo "#BPM:$BPM"
    echo "#GAP:$GAP_MS"
    beat=0
    for i in "${!PITCHES[@]}"; do
        # ": <startbeat> <length> <pitch> <text>" — leading space on the text is
        # part of the format (it is what separates syllables into words).
        echo ": $beat $NOTE_BEATS ${PITCHES[$i]} ${SYLLABLES[$i]} "
        beat=$((beat + NOTE_BEATS))
        # Break the scale into two phrases so the app has two lines to display.
        [[ $i -eq 3 ]] && echo "- $beat"
    done
    echo "E"
} > "$DIR/$NAME.txt"

# Hand the whole folder to whoever runs the server.
OWNER="$(stat -c '%U:%G' "$SONGS_DIR" 2>/dev/null || echo '')"
[[ -n "$OWNER" && "$OWNER" != "UNKNOWN:UNKNOWN" ]] && chown -R "$OWNER" "$DIR" || true

echo
echo "=== done ==="
ls -la "$DIR" | sed 's/^/  /'
echo
# A restart will NOT pick this up: the server pins the library folder on startup
# and skips the scan when the path is unchanged ("library already pinned to
# folder; not rescanning"). Ask it to scan explicitly.
echo "Now tell the server to scan (a restart will not do it):"
echo "  curl -sS -X POST http://127.0.0.1:8088/api/cmd/trigger_scan \\"
echo "       -H 'content-type: application/json' -d '{}'"
