// Auto-submitting HTML page for gateways that only accept a signed form POST
// (BORICA). The 2026-10-26 failure: the agent was told to "write a tiny HTML
// page" and the argument about how to deliver it burned the 10-minute window.
// Now the server hosts the page itself; the user gets one clickable link.

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function buildPayFormPage(gatewayUrl: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`,
    )
    .join("\n");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Пренасочване към платежната страница…</title></head>
<body onload="document.forms[0].submit()">
<p>Пренасочване към платежната страница… Ако ничего не се случи, натиснете бутона.</p>
<form method="POST" action="${escapeAttr(gatewayUrl)}">
${inputs}
<noscript><button type="submit">Продължи към плащането</button></noscript>
</form>
</body>
</html>
`;
}
