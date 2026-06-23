"""Find extra closing braces in PanelSettings.jsx."""
import re
import pathlib

p = pathlib.Path("src/PanelSettings.jsx")
c = p.read_text()
lines = c.split("\n")

# Strip strings and comments per line for accurate counting
def strip(s):
    # Remove single-line comments
    s = re.sub(r"//[^\n]*", "", s)
    return s

# Per-line brace diff
print("Lines with extra closing braces (after stripping strings):")
for i, line in enumerate(lines, 1):
    s = line
    # Remove string literals (both ' and ")
    s = re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)
    s = re.sub(r"'(?:[^'\\]|\\.)*'", "''", s)
    s = re.sub(r"`(?:[^`\\]|\\.)*`", "``", s)
    s = strip(s)
    opens = s.count("{")
    closes = s.count("}")
    if closes > opens:
        print(f"  line {i}: {line!r}  (diff: +{closes-opens})")
