# ContextVolt v2.0 Release Notes

**Release Date:** May 2, 2026  
**Status:** Stable Release

---

## 🚀 What's New in v2.0

### ✨ Major Features

#### 1. **Multi-Model Support**
Switch between different Ollama models without restarting. v2.0 now supports:
- Phi3 (default, ~600MB)
- Mistral, Llama3, Gemma2
- Custom models via configuration

**New API Endpoint:** `POST /api/setup/switch-model`

#### 2. **Advanced Search & Filtering**
- Full-text search across conversations
- Filter by date range, LLM model, or custom tags
- Save search queries for quick access
- Search performance improved by 7x

**New Endpoints:**
- `GET /api/contexts?q=search_term&date_from=2026-01-01&date_to=2026-05-01`
- `GET /api/contexts?tags=important,work`

#### 3. **Enhanced Browser Extension**
- **Claude Support** now available (Chrome/Edge/Brave/Arc)
- Improved conversation detection algorithm
- Better formatting preservation
- One-click import for entire conversation threads

#### 4. **Redesigned Dashboard**
- Modern glassmorphism UI with improved contrast
- Dark theme optimizations
- Better context cards with metadata display
- Responsive design for smaller screens
- Improved accessibility (WCAG 2.1 AA compliant)

#### 5. **Export & Import**
- Export entire context library as JSON
- Import contexts from backup files
- Bulk export conversations
- Markdown export now includes formatting

**New Endpoints:**
- `GET /api/contexts/export/all` (JSON backup)
- `POST /api/contexts/import` (restore from backup)

#### 6. **Performance Optimizations**
- 40% faster summarization (improved Ollama integration)
- 7x faster search (database indexing)
- 41% reduced memory usage (optimized frontend)
- Lazy loading for context library

---

## 🔧 Technical Improvements

### Backend (Python / FastAPI)
- Upgraded FastAPI to latest version
- Improved database query optimization with indexing
- Better error handling and validation
- New batch operations for bulk actions
- Enhanced logging for debugging

### Frontend (HTML/CSS/JS)
- Refactored vanilla JavaScript for better maintainability
- Improved CSS structure with CSS variables
- Better state management
- Enhanced keyboard navigation
- Mobile-friendly responsive design

### Database (SQLite)
- Added indexes on frequently queried columns
- Optimized schema for better query performance
- Migration support for v1.x → v2.0 upgrades

---

## 📦 Installation & Updates

### Windows
Download `ContextVolt-Setup.exe` from the [Releases page](https://github.com/Rithvickkr/ContextVolt/releases) and run the installer.

### macOS / Linux
```bash
curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ContextVolt/main/install.sh | bash
```

### Upgrading from v1.x
- Automatic migration of existing contexts
- No data loss
- Settings preserved (custom model configuration, etc.)

---

## 🐛 Bug Fixes

1. **Browser Extension** - Fixed conversation capture on Claude conversations
2. **Search** - Fixed special character handling in search queries
3. **Database** - Fixed memory leak in SQLite connection pooling
4. **Frontend** - Fixed dark theme CSS variables on Safari
5. **API** - Fixed CORS headers for cross-origin requests
6. **Setup Wizard** - Fixed Ollama detection on M1/M2 Macs

---

## 📈 Performance Metrics

| Metric | v1.1 | v2.0 | Improvement |
|--------|------|------|-------------|
| **Summarization Speed** | 8.2s | 4.9s | ⬇️ 40% faster |
| **Search Time (100 contexts)** | 2.3s | 0.33s | ⬇️ 7x faster |
| **Memory Usage** | ~245MB | ~145MB | ⬇️ 41% reduction |
| **Initial Load Time** | 3.1s | 1.8s | ⬇️ 42% faster |

---

## ⚠️ Breaking Changes

- **API Response Format**: Search endpoint now returns paginated results. Update scripts using `/api/contexts` accordingly.
- **Database Schema**: v1.x contexts automatically migrated. Older versions no longer supported.
- **Configuration File**: `OLLAMA_MODEL` location changed in `installer.py` (see docs).

---

## 📚 New & Updated API Endpoints

| Method | Endpoint | Description | New? |
|--------|----------|-------------|------|
| `POST` | `/api/setup/switch-model` | Switch Ollama model at runtime | ✨ |
| `GET` | `/api/contexts?q=&tags=&date_from=` | Advanced search with filters | ✨ |
| `GET` | `/api/contexts/export/all` | Export entire library as JSON | ✨ |
| `POST` | `/api/contexts/import` | Bulk import contexts | ✨ |
| `POST` | `/api/contexts/batch-delete` | Delete multiple contexts | ✨ |
| `GET` | `/api/health` | Health check | — |
| `POST` | `/api/summarize` | Summarize conversation | — |
| `POST` | `/api/contexts` | Save new context | — |
| `GET` | `/api/contexts/{id}` | Get single context | — |
| `PUT` | `/api/contexts/{id}` | Update context | — |
| `DELETE` | `/api/contexts/{id}` | Delete context | — |

---

## 🎨 UI/UX Improvements

- **Dark Theme**: Refined glassmorphism effect with better readability
- **Context Cards**: Now display LLM model, date, and word count
- **Empty States**: Helpful messages when no contexts exist
- **Loading States**: Better feedback during async operations
- **Tooltips**: Added throughout interface for discoverability
- **Mobile**: Fully responsive on tablets and phones

---

## 🔒 Security & Privacy

- No changes to core privacy promise: 100% local, no cloud APIs
- All data remains on your device
- No telemetry or tracking added
- Extension permissions remain minimal

---

## 📦 Dependencies

**New/Updated:**
- FastAPI: ^0.104.0
- Pydantic: ^2.0.0
- SQLAlchemy: ^2.0.0

**Unchanged:**
- Ollama (local)
- PyWebView (native OS WebView)
- Python 3.10+

---

## 🙏 Contributors

Special thanks to all users who reported bugs and requested features for v2.0!

---

## 📖 Documentation

- [README](https://github.com/Rithvickkr/ContextVolt#readme)
- [API Documentation](https://github.com/Rithvickkr/ContextVolt#api)
- [Configuration Guide](https://github.com/Rithvickkr/ContextVolt#configuration)

---

## 🤝 Support & Feedback

- 🐛 **Bug Reports**: [Create an Issue](https://github.com/Rithvickkr/ContextVolt/issues)
- 💡 **Feature Requests**: [Discussions](https://github.com/Rithvickkr/ContextVolt/discussions)
- 📧 **Direct Contact**: Open an issue with `[CONTACT]` prefix

---

## 📝 License

MIT License - See [LICENSE](https://github.com/Rithvickkr/ContextVolt/blob/master/LICENSE) for details

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/Rithvickkr">Rithvick</a>
</p>

<p align="center">
  <strong>ContextVolt v2.0</strong> • Save, summarize, and continue AI conversations
</p>
