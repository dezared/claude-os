// Shared by the server's headers and the page's preview: a document may show itself and nothing else.
export const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

// A knowledge file as the UI shows it: the `*_ru` frontmatter fields in Russian, the plain ones otherwise.
export function knowledgeLabel(k: { name: string; nameRu: string | null; description: string; descriptionRu: string | null }, language: string): { name: string; description: string } {
  return language === 'ru' ? { name: k.nameRu ?? k.name, description: k.descriptionRu ?? k.description } : { name: k.name, description: k.description };
}

// What a chat link to a document looks like. The page turns a click on it into the document's tab.
export const documentLink = (id: string) => `/documents/${encodeURIComponent(id)}`;

export function documentIdFromLink(href: string): string | null {
  const m = /^\/documents\/([^/?#]+)$/.exec(href);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
