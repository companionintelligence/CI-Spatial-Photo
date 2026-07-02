import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";

// Niantic .spz — compressed Gaussian format (~10x smaller than .ply). The server transcodes
// every splat's master PLY to spz, and the viewer prefers it on the wire.
export const spzFormat = {
  id: "spz",
  label: "SPZ",
  extensions: ["spz"],
  async loadData({ file, bytes }) {
    const mesh = new SplatMesh({
      fileBytes: bytes,
      fileType: SplatFileType.SPZ,
      fileName: file?.name,
    });
    await mesh.initialized;
    return mesh;
  },
  async loadMetadata() {
    // spz carries no camera metadata; the viewer falls back to bounding-box framing.
    return null;
  },
};
