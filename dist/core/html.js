// src/core/html.ts
/** Escape text for use in HTML content and quoted attributes. */
function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[c]);
}
export { escapeHtml };

//# sourceMappingURL=html.js.map