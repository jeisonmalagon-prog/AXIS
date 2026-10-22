// Tapa valores que parecen credenciales dentro de un texto libre (mensajes de
// error, logs de pipelines, URLs con ?token=...). Se usa antes de mostrar al
// navegador cualquier texto que venga de sistemas externos (n8n, Azure DevOps).
function ocultarSecretos(texto) {
  return String(texto)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 ***')
    .replace(/([?&;\s"'](?:[\w.-]*(?:token|key|secret|password|passwd|pwd|authorization|signature|credential)[\w.-]*)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;]+)/gi, '$1***')
    .replace(/(:\/\/[^\/\s:@]+:)[^\/\s@]+@/g, '$1***@')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***')
    // PAT de Azure DevOps (52 caracteres base32 en minúscula/dígitos) y claves tipo sk-/ghp_/AKIA
    .replace(/\b[a-z2-7]{52}\b/g, '***')
    .replace(/\b(?:ghp|gho|ghs|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, '***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***');
}

module.exports = { ocultarSecretos };
