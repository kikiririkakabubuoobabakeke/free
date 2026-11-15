const MAX_SIDE = 1600;
const QUALITY = 0.85;

/**
 * 選ばれた画像を長辺1600pxまでに縮め、JPEGのbase64にする。
 * 端末の容量と、同期先の無料枠を食い過ぎないため。
 */
export async function prepareImage(
  file: File,
): Promise<{ mime: string; width: number; height: number; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.fillStyle = "#fff"; // 透過PNGの透明部分は白にする
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
  return { mime: "image/jpeg", width, height, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
