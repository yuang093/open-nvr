#!/usr/bin/env python3
"""Fix JSX: wrap return expression in Fragment to allow 2 sibling Dialogs.

Current state after install_plan3.py + patch_panel_modal.py:
  line 293:    return panel.open && (
  line 294: (empty)
  line 295:      <Dialog modalType='modal' open={panel.open}>
  ...
  line 698:        </Dialog>
  line 699: (empty)
  line 700:        {analysisOpen && (
  ...
  line  47:        </Dialog>
  line  48:      )}
  line  49:    }       <-- function PanelSettings close (4 spaces)
  line  50: (empty)
  line  51: }        <-- export closing

We need to:
  1. Insert `<>` after `return panel.open && (`
  2. Insert `</>` after `      )}` (modal close)
"""
import os
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))
panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()

# 1. Wrap opening in Fragment <>
# Anchor: return panel.open && ( followed by blank line, then <Dialog modalType='modal' open={panel.open}>
old_open = '''    return panel.open && (

      <Dialog modalType='modal' open={panel.open}>
'''
new_open = '''    return panel.open && (

      <>
      <Dialog modalType='modal' open={panel.open}>
'''
if old_open not in content:
    print("[fix] ERROR: open anchor not found")
    print("[fix] Looking for 'return panel.open' lines:")
    for i, line in enumerate(content.split('\n')):
        if 'return panel.open' in line or 'Dialog modalType' in line:
            print(f"  line {i+1}: {line!r}")
    sys.exit(1)
content = content.replace(old_open, new_open, 1)
print("[fix] Wrapped opening in Fragment <>")

# 2. Close Fragment </> before function close
# Anchor: modal's `      )}` then `    }` (4-space function close) then blank then `}`
old_close = '''        </Dialog>
      )}
    }

}'''
new_close = '''        </Dialog>
      )}
      </>
    }

}'''
if old_close not in content:
    print("[fix] ERROR: close anchor not found")
    print("[fix] Last 400 chars of file:")
    print(repr(content[-400:]))
    sys.exit(1)
content = content.replace(old_close, new_close, 1)
print("[fix] Closed Fragment </>")

panel_path.write_text(content)
print(f"[fix] Patched {panel_path}")
