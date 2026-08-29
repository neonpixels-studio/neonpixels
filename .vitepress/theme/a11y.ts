// Single source of truth for the primary-content landmark id, shared by the
// skip link (rendered once in AppLayout) and the <main> each page view exposes
// (the home page and the 404 page), so the bypass target and its destination
// can never drift apart (WCAG 2.4.1 bypass-blocks).
export const MAIN_CONTENT_ID = "main-content";
