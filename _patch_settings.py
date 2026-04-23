"""Patch: Add cloud key event listeners"""
import pathlib

APP = pathlib.Path(r"e:\ConVX\frontend\js\app.js")
text = APP.read_text(encoding="utf-8")

# Detect line ending
NL = "\r\n" if "\r\n" in text[:500] else "\n"

marker = "    $('#settings-modal').addEventListener('click', (e) => {" + NL + \
         "        if (e.target === $('#settings-modal')) closeSettingsModal();" + NL + \
         "    });"
idx = text.find(marker)
assert idx > 0, f"marker not found (NL={repr(NL)})"

insert_at = idx + len(marker)

INSERT = NL.join([
    "",
    "",
    "    // Cloud key: validate button",
    "    const _cloudValidateBtn = $('#cloud-key-validate-btn');",
    "    if (_cloudValidateBtn) {",
    "        _cloudValidateBtn.addEventListener('click', async () => {",
    "            const keyInput = $('#cloud-key-input');",
    "            const key = keyInput ? keyInput.value.trim() : '';",
    "            if (!key) { _setKeyStatus('invalid', 'Please enter an API key'); return; }",
    "            _setKeyStatus('validating', 'Validating\u2026');",
    "            _cloudValidateBtn.disabled = true;",
    "            try {",
    "                const r = await fetch(`${API}/api/setup/validate-key`, {",
    "                    method: 'POST', headers: {'Content-Type':'application/json'},",
    "                    body: JSON.stringify({ provider: _selectedProvider, api_key: key })",
    "                });",
    "                const data = await r.json();",
    "                if (data.valid) {",
    "                    _setKeyStatus('valid', '\u2713 Key valid \u2014 ready to use');",
    "                    _cloudKeyValid[_selectedProvider] = true;",
    "                } else {",
    "                    _setKeyStatus('invalid', data.error || 'Invalid key');",
    "                    _cloudKeyValid[_selectedProvider] = false;",
    "                }",
    "            } catch (err) {",
    "                _setKeyStatus('invalid', 'Validation failed: ' + err.message);",
    "            } finally {",
    "                _cloudValidateBtn.disabled = false;",
    "            }",
    "        });",
    "    }",
    "",
    "    // Cloud key: show/hide toggle",
    "    const _cloudKeyToggle = $('#cloud-key-toggle');",
    "    if (_cloudKeyToggle) {",
    "        _cloudKeyToggle.addEventListener('click', () => {",
    "            const ki = $('#cloud-key-input');",
    "            ki.type = ki.type === 'password' ? 'text' : 'password';",
    "        });",
    "    }",
])

text = text[:insert_at] + INSERT + text[insert_at:]
APP.write_text(text, encoding="utf-8")
print(f"OK - inserted {len(INSERT)} chars at {insert_at}")
