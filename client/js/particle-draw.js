import * as THREE from "three";

// Indexed Points draw ONLY living slots. Black/dead transparent points still
// cost vertex and fragment work, especially large fireworks/smoke sprites.
// Storage remains fixed-size and is reused when quality changes.
export class ParticleDraw {
  constructor(points, capacity) {
    this.points = points;
    this.index = new THREE.BufferAttribute(new Uint16Array(capacity), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    points.geometry.setIndex(this.index);
    for (const attr of Object.values(points.geometry.attributes))
      attr.setUsage(THREE.DynamicDrawUsage);
    this.reset();
  }

  reset() {
    this.count = 0;
    this.maxSlot = -1;
    this.points.visible = false;
    this.points.geometry.setDrawRange(0, 0);
  }

  add(slot) {
    this.index.array[this.count++] = slot;
    this.maxSlot = Math.max(this.maxSlot, slot);
  }

  finish() {
    const g = this.points.geometry;
    this.points.visible = this.count > 0;
    g.setDrawRange(0, this.count);
    if (!this.count) return;
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, this.count);
    this.index.needsUpdate = true;
    for (const attr of Object.values(g.attributes)) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, (this.maxSlot + 1) * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}
