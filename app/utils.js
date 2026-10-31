export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

export function downloadJson(filename, obj) {
  const blob = new Blob([stableStringify(obj)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

