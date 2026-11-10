import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({ bash, css, diff, go, ini, java, javascript, json, markdown, php, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);
hljs.registerAliases(['toml'], { languageName: 'ini' });

// A stream renders its whole text on every frame: blocks that are already complete come from here.
const CACHE_SIZE = 300;
const MAX_CODE = 100_000;
const cache = new Map<string, string>();

/** The block's HTML, or null when its language is unknown: no guessing, detection is slow and often wrong. */
export function highlightCode(code: string, lang: string | undefined): string | null {
  if (!lang || code.length > MAX_CODE || !hljs.getLanguage(lang)) return null;
  const key = `${lang}\n${code}`;
  let html = cache.get(key);
  if (html === undefined) {
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, html);
  }
  return html;
}
