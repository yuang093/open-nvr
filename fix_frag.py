#!/usr/bin/env python3
"""Fix JSX: wrap return expression in Fragment to allow 2 sibling Dialogs."""
import os
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))
panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()

# After the patch, the structure is:
#   return panel.open && (
#       <Dialog>...</Dialog>
#
#       {analysisOpen && (
#         <Dialog>...</Dialog>
#       )}
#   )
# We need to wrap both Dialogs in a Fragment

# Anchor: the main Dialog closes with `</Dialog> \n\n      {analysisOpen`
# We need to insert `<>` after `(` and `</>` before `)`
old_struct = '''    return panel.open && (
      <Dialog modalType='modal' open={panel.open}>
'''
new_struct = '''return panel.open && (
      <>
      <Dialog modalType='modal' open={panel.open}>
'''
if old_struct not in content:
    print("[fix] ERROR: open Dialog anchor not found")
    print("[fix] Searching near 'return panel.open':")
    for i, line in enumerate(content.split('\n')):
        if 'return panel.open' in line:
            print(f"  line {i}: {line!r}")
    sys.exit(1)
content = content.replace(old_struct, new_struct, 1)
print("[fix] Wrapped opening in Fragment <>")

# Now find the closing: original was `      </Dialog> \n    )\n    \n}` and got replaced
# The new ending (from patch_panel_modal.py) is:
#   `      </Dialog> \n\n      {analysisOpen && (\n        <Dialog...`
# Wait — patch replaced `</Dialog> \n    )\n    \n}` with new content that starts with `</Dialog>\n\n      {analysisOpen`
# So the structure NOW is:
#   `      </Dialog>\n\n      {analysisOpen && (\n        <Dialog modalType='modal'...` (from patch)
#   ...modal content...
#   `}\n    \n}` (the actual end of function)

# So we need to find the new end and close the Fragment
# Old: the modal ends with `}\n    \n}` (last `}` is the function close, the one before is the conditional close)

# The new content's end is:
# `      )}\n    }\n\n}` (the conditional close, then 4-space-indent closing brace of function)
# We need to add `</>` between `)}` and `\n    }`

old_end = '''        </Dialog>
      )}
    }

}'''
new_end = '''        </Dialog>
      )}
      </>
    }

}'''
if old_end not in content:
    print("[fix] ERROR: end anchor not found")
    print("[fix] Last 300 chars:")
    print(repr(content[-300:]))
    sys.exit(1)
content = content.replace(old_end, new_end, 1)
print("[fix] Closed Fragment </>")

panel_path.write_text(content)
print(f"[fix] Patched {panel_path}")
