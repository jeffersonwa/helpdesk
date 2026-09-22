// Renderizador de Markdown MÍNIMO (sem dependências externas), suficiente para
// os manuais internos: títulos (#, ##, ###), listas (-), tabelas (| | |),
// blocos de código (```), citações (>), regras (---), negrito (**), código
// inline (`) e parágrafos. NÃO é um parser completo de Markdown — cobre apenas
// o subconjunto usado nos arquivos docs/manual-*.md.
//
// Segurança: as fontes são arquivos ESTÁTICOS do próprio repositório (não
// entrada de usuário), mas ainda assim escapamos HTML antes de aplicar a
// formatação inline, para evitar injeção caso o conteúdo mude no futuro.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // Aplica formatação inline sobre texto JÁ escapado.
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-100 text-[0.85em] font-mono">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>');
}

/** Converte o subconjunto de Markdown dos manuais em HTML (string). */
export function renderManual(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushListOpen = { ul: false };
  const closeList = () => {
    if (flushListOpen.ul) {
      out.push("</ul>");
      flushListOpen.ul = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Bloco de código ```
    if (line.trimStart().startsWith("```")) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // pula o ``` de fechamento
      out.push(
        `<pre class="my-3 p-3 rounded-lg bg-gray-900 text-gray-100 text-xs overflow-x-auto"><code>${buf.join("\n")}</code></pre>`,
      );
      continue;
    }

    // Tabela (linha começa com | e a próxima é o separador |---|)
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      closeList();
      const header = line.split("|").slice(1, -1).map((c) => c.trim());
      i += 2; // pula cabeçalho + separador
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      const thead = `<thead><tr>${header.map((h) => `<th class="text-left font-semibold px-3 py-2 border-b bg-gray-50">${inline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td class="px-3 py-2 border-b align-top">${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<div class="my-4 overflow-x-auto"><table class="w-full text-sm border rounded-lg">${thead}${tbody}</table></div>`);
      continue;
    }

    // Títulos
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      const cls =
        level === 1
          ? "text-2xl font-bold text-gray-900 mt-2 mb-4"
          : level === 2
            ? "text-xl font-semibold text-gray-900 mt-6 mb-3"
            : level === 3
              ? "text-base font-semibold text-gray-800 mt-4 mb-2"
              : "text-sm font-semibold text-gray-700 mt-3 mb-1";
      out.push(`<h${level} class="${cls}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Regra horizontal
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr class="my-5 border-gray-200" />');
      i++;
      continue;
    }

    // Citação
    if (line.startsWith(">")) {
      closeList();
      out.push(
        `<blockquote class="my-3 pl-4 border-l-4 border-blue-200 text-gray-600 text-sm">${inline(line.replace(/^>\s?/, ""))}</blockquote>`,
      );
      i++;
      continue;
    }

    // Item de lista
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li) {
      if (!flushListOpen.ul) {
        out.push('<ul class="my-2 ml-5 list-disc space-y-1 text-sm text-gray-700">');
        flushListOpen.ul = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }

    // Linha em branco
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // Parágrafo
    closeList();
    out.push(`<p class="my-2 text-sm text-gray-700 leading-relaxed">${inline(line)}</p>`);
    i++;
  }

  closeList();
  return out.join("\n");
}
