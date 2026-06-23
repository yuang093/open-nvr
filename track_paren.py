"""Track paren balance from return statement."""
import re

c = open("src/PanelSettings.jsx").read()
lines = c.split("\n")
o = 0
cl = 0
for i, line in enumerate(lines[334:], 335):
    s = line
    s = re.sub(r"'[^']*'", "", s)
    s = re.sub(r'"[^"]*"', "", s)
    o += s.count("(")
    cl += s.count(")")
    if o - cl > 1:
        print(f"  line {i}: open={o}, close={cl}, diff={o-cl}  {line[:80]!r}")
        if o - cl > 3:
            break
print(f"Final: open={o}, close={cl}, diff={o-cl}")
