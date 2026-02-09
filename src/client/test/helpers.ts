/** Convert a Blob to a number array for assertion comparisons. */
export async function blobToArray(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

/** Convert a Uint8Array to a number array for assertion comparisons. */
export function toArray(data: Uint8Array): number[] {
  return Array.from(data);
}
