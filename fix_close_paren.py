#!/usr/bin/env python3
"""Add the missing '    )' that closes 'return panel.open && ('.

Current broken state (line 793-800):
          </DialogSurface>
        </Dialog>
      )}
      </>
    }

Fix to:
          </DialogSurface>
        </Dialog>
      )}
      </>
    )
    }
"""
import os
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))
panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()

old = '      </>\n    }\n\n}'
new = '      </>\n    )\n    }\n\n}'
if old not in content:
    print("[fix] ERROR: anchor not found")
    print("[fix] Last 400 chars of file:")
    print(repr(content[-400:]))
    sys.exit(1)
content = content.replace(old, new, 1)
panel_path.write_text(content)
print(f"[fix] Added missing '    )' to close return expression")
print(f"[fix] Patched {panel_path}")
