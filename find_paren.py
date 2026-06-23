"""Find lines with more ( than )."""
import re

c = open("src/PanelSettings.jsx").read()
lines = c.split("\n")
for i, line in enumerate(lines[173:857], 174):
    s = line
    s = re.sub(r"'[^']*'", "''", s)
    s = re.sub(r'"[^"]*"', '""', s)
    o = s.count("(")
    c2 = s.count(")")
    if o > c2:
        print(f"  line {i}: +{o-c2}  {line[:140]!r}")
