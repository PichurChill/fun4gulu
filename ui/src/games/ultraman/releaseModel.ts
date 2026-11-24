import { Mesh, Texture, type Object3D } from 'three'

/** 释放一次 GLB 加载所拥有的网格和共享贴图。 */
export function releaseModel(model: Object3D) {
  const textures = new Set<Texture>()
  model.traverse(node => {
    if (!(node instanceof Mesh)) return
    node.geometry.dispose()
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value)
      }
      material.dispose()
    }
  })
  for (const texture of textures) texture.dispose()
}
