import * as THREE from 'three'
import type { PlayerSlot } from './types'

interface Particle {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  gravity: number
  startScale: number
}

interface ImpactRing {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  maxRadius: number
}

interface HitFlash {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  startScale: number
}

export interface DiscProjectile {
  kind: 'disc'
  fromSlot: PlayerSlot
  mesh: THREE.Object3D
  pos: THREE.Vector3
  vel: THREE.Vector3
  damage: number
  age: number
  maxAge: number
  hitTriggered: boolean
}

export interface BeamFrameInput {
  /** 光线发射手臂段（肘→腕） */
  segment: [THREE.Vector3, THREE.Vector3]
  /** 光线命中目标点（对手胸口） */
  target: THREE.Vector3
  isSuper: boolean
}

const SLOT_ACCENTS: [number, number] = [0x38e8ff, 0x7df9ff]

/**
 * 横版格斗特效系统：双人平行光束、立式八分光轮、格挡光墙、蓄力光球、
 * 命中粒子/冲击环/爆闪、KO 爆炸与地面站位指示环
 */
export class DuelEffects {
  private readonly group = new THREE.Group()
  private particles: Particle[] = []
  private impactRings: ImpactRing[] = []
  private hitFlashes: HitFlash[] = []
  public projectiles: DiscProjectile[] = []

  private readonly sparkGeo = new THREE.SphereGeometry(0.45, 6, 6)
  private readonly orbGeo = new THREE.SphereGeometry(1, 14, 12)
  private readonly cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true)

  // 双人各一套光线（可同时发射对轰）
  private readonly beamGroups: THREE.Group[] = []
  private readonly beamCores: THREE.Mesh[] = []
  private readonly beamOuters: THREE.Mesh[] = []
  private readonly beamFilaments: THREE.Mesh[][] = []
  private readonly beamOriginOrbs: THREE.Mesh[] = []
  private readonly beamImpactOrbs: THREE.Mesh[] = []
  private readonly beamColors: number[] = [0x38d9ff, 0x9be7ff]

  // 双人各一套护盾光墙
  private readonly shieldMeshes: THREE.Mesh[] = []
  private readonly shieldFlashes: [number, number] = [0, 0]

  // 双人各一套蓄力光球（光线 / 光轮）
  private readonly beamChargeOrbs: THREE.Mesh[] = []
  private readonly discChargePreviews: THREE.Group[] = []

  // 地面站位指示环（P1 / P2）
  private readonly groundMarkers: THREE.Mesh[] = []

  private readonly upAxis = new THREE.Vector3(0, 1, 0)

  constructor(scene: THREE.Scene) {
    this.group.name = 'DuelEffects'
    scene.add(this.group)

    for (let slot = 0; slot < 2; slot++) {
      const accent = SLOT_ACCENTS[slot]!

      // 光线组
      const beamGroup = new THREE.Group()
      const core = new THREE.Mesh(
        this.cylGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.96,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      const outer = new THREE.Mesh(
        this.cylGeo,
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.58,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      beamGroup.add(core, outer)

      const filaments: THREE.Mesh[] = []
      for (let i = 0; i < 6; i++) {
        const f = new THREE.Mesh(
          this.cylGeo,
          new THREE.MeshBasicMaterial({
            color: i % 2 === 0 ? 0xa5f3fc : 0xfef08a,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        )
        beamGroup.add(f)
        filaments.push(f)
      }

      const originOrb = new THREE.Mesh(
        this.orbGeo,
        new THREE.MeshBasicMaterial({
          color: 0xe0f7ff,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      const impactOrb = new THREE.Mesh(
        this.orbGeo,
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.88,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      beamGroup.add(originOrb, impactOrb)
      beamGroup.visible = false
      this.group.add(beamGroup)
      this.beamGroups.push(beamGroup)
      this.beamCores.push(core)
      this.beamOuters.push(outer)
      this.beamFilaments.push(filaments)
      this.beamOriginOrbs.push(originOrb)
      this.beamImpactOrbs.push(impactOrb)

      // 护盾光墙（面向镜头微倾，横版下清晰可读）
      const shield = new THREE.Mesh(
        new THREE.CircleGeometry(4.8, 6),
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      const shieldEdge = new THREE.LineLoop(
        new THREE.EdgesGeometry(shield.geometry),
        new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.9 }),
      )
      shield.add(shieldEdge)
      shield.visible = false
      this.group.add(shield)
      this.shieldMeshes.push(shield)

      // 蓄力光球与光轮预览
      const chargeOrb = new THREE.Mesh(
        this.orbGeo,
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      chargeOrb.visible = false
      this.group.add(chargeOrb)
      this.beamChargeOrbs.push(chargeOrb)

      const discPreview = this.createSawDiscMesh(1.8, accent)
      discPreview.visible = false
      this.group.add(discPreview)
      this.discChargePreviews.push(discPreview)

      // 地面站位指示环
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(3.6, 4.6, 36),
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      )
      marker.rotation.x = -Math.PI / 2
      marker.position.y = 0.14
      this.group.add(marker)
      this.groundMarkers.push(marker)
    }
  }

  /** 立式锯齿光轮网格（面朝镜头，沿 X 轴飞行） */
  private createSawDiscMesh(radius: number, colorHex: number): THREE.Group {
    const g = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.35, radius, 24),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.45, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    g.add(ring, core)

    const toothGeo = new THREE.ConeGeometry(radius * 0.22, radius * 0.55, 4)
    const toothMat = new THREE.MeshBasicMaterial({
      color: 0xe0f7ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const tooth = new THREE.Mesh(toothGeo, toothMat)
      tooth.position.set(Math.cos(a) * radius * 1.05, Math.sin(a) * radius * 1.05, 0)
      tooth.rotation.z = a - Math.PI / 2
      g.add(tooth)
    }
    return g
  }

  public setBeamColor(slot: PlayerSlot, colorHex: number) {
    this.beamColors[slot] = colorHex
    ;(this.beamOuters[slot]!.material as THREE.MeshBasicMaterial).color.setHex(colorHex)
    ;(this.beamImpactOrbs[slot]!.material as THREE.MeshBasicMaterial).color.setHex(colorHex)
    ;(this.beamChargeOrbs[slot]!.material as THREE.MeshBasicMaterial).color.setHex(colorHex)
  }

  public setDiscColor(slot: PlayerSlot, colorHex: number) {
    this.discChargePreviews[slot]!.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mat = (node as THREE.Mesh).material
        if (mat instanceof THREE.MeshBasicMaterial && mat.opacity < 1) mat.color.setHex(colorHex)
      }
    })
  }

  public spawnDisc(
    slot: PlayerSlot,
    origin: THREE.Vector3,
    dirX: number,
    damage: number,
    colorHex: number,
  ) {
    const disc = this.createSawDiscMesh(2.5, colorHex)
    disc.position.copy(origin)
    this.group.add(disc)
    this.projectiles.push({
      kind: 'disc',
      fromSlot: slot,
      mesh: disc,
      pos: origin.clone(),
      vel: new THREE.Vector3(Math.sign(dirX) * 58, 0, 0),
      damage,
      age: 0,
      maxAge: 1.4,
      hitTriggered: false,
    })
  }

  public spawnBurst(pos: THREE.Vector3, colorHex: number, count = 16, speed = 18, scale = 1.0) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xffffff : colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.sparkGeo, mat)
      mesh.position.copy(pos)
      const s = (0.6 + Math.random() * 1.1) * scale
      mesh.scale.setScalar(s)
      this.group.add(mesh)

      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI - Math.PI * 0.35
      const spd = speed * (0.45 + Math.random() * 0.85)
      this.particles.push({
        mesh,
        vx: Math.cos(theta) * Math.cos(phi) * spd,
        vy: Math.sin(phi) * spd + speed * 0.25,
        vz: Math.sin(theta) * Math.cos(phi) * spd * 0.5,
        life: 0,
        maxLife: 0.32 + Math.random() * 0.38,
        gravity: 22,
        startScale: s,
      })
    }
  }

  public spawnImpactRing(pos: THREE.Vector3, colorHex: number, maxRadius = 7) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1, 28),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    ring.position.copy(pos)
    ring.scale.setScalar(0.4)
    this.group.add(ring)
    this.impactRings.push({ mesh: ring, life: 0, maxLife: 0.3, maxRadius })
  }

  public spawnHitFlash(pos: THREE.Vector3, colorHex: number, scale = 1) {
    const flash = new THREE.Mesh(
      this.sparkGeo,
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    flash.position.copy(pos)
    flash.scale.setScalar(0.5 * scale)
    this.group.add(flash)
    this.hitFlashes.push({ mesh: flash, life: 0, maxLife: 0.16, startScale: scale })
  }

  /** KO 大爆炸（被击倒者位置） */
  public spawnKoExplosion(pos: THREE.Vector3, colorHex: number) {
    this.spawnImpactRing(pos, 0xffd28a, 16)
    this.spawnBurst(pos, colorHex, 42, 36, 1.9)
    this.spawnBurst(pos.clone().add(new THREE.Vector3(0, 3, 0.5)), 0xfacc15, 30, 30, 1.6)
    this.spawnHitFlash(pos, 0xfff7cc, 2.6)
  }

  public triggerShieldFlash(slot: PlayerSlot) {
    this.shieldFlashes[slot] = 1
  }

  public updateShield(
    slot: PlayerSlot,
    active: boolean,
    x: number,
    facing: 1 | -1,
    dt: number,
    elapsed: number,
  ) {
    const shield = this.shieldMeshes[slot]!
    this.shieldFlashes[slot] = Math.max(0, this.shieldFlashes[slot]! - dt * 3.2)
    const flash = this.shieldFlashes[slot]!
    shield.visible = active || flash > 0.05
    if (!shield.visible) return
    shield.position.set(x + facing * 3.4, 8.9, 0)
    shield.rotation.set(0, -facing * 0.42, 0)
    const pulse = 1 + Math.sin(elapsed * 12) * 0.04 + flash * 0.22
    shield.scale.setScalar(pulse)
    const mat = shield.material as THREE.MeshBasicMaterial
    mat.color.setHex(flash > 0.2 ? 0xfef08a : SLOT_ACCENTS[slot]!)
    mat.opacity = active ? 0.32 + flash * 0.45 : flash * 0.5
  }

  public updateChargePreview(
    slot: PlayerSlot,
    beamCharge: number,
    beamPos: THREE.Vector3,
    discCharge: number,
    discPos: THREE.Vector3,
    elapsed: number,
  ) {
    const orb = this.beamChargeOrbs[slot]!
    const beamActive = this.beamGroups[slot]!.visible
    if (beamCharge > 0.05 && !beamActive) {
      orb.visible = true
      orb.position.copy(beamPos)
      const s = 0.65 + beamCharge * 1.9 + Math.sin(elapsed * 26) * 0.16
      orb.scale.setScalar(s)
    } else {
      orb.visible = false
    }

    const preview = this.discChargePreviews[slot]!
    if (discCharge > 0.08) {
      preview.visible = true
      preview.position.copy(discPos)
      preview.scale.setScalar(0.35 + discCharge * 0.85)
      preview.rotation.z += 0.28
    } else {
      preview.visible = false
    }
  }

  public updateGroundMarker(slot: PlayerSlot, x: number, elapsed: number, danger: boolean) {
    const marker = this.groundMarkers[slot]!
    marker.position.x = x
    const mat = marker.material as THREE.MeshBasicMaterial
    mat.opacity = 0.32 + Math.abs(Math.sin(elapsed * 2.2 + slot)) * 0.3
    mat.color.setHex(danger ? 0xff3b30 : SLOT_ACCENTS[slot]!)
  }

  private alignCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
    const dir = to.clone().sub(from)
    const len = Math.max(0.01, dir.length())
    mesh.position.copy(from).addScaledVector(dir, 0.5)
    mesh.quaternion.setFromUnitVectors(this.upAxis, dir.normalize())
    mesh.scale.set(radius, len, radius)
  }

  /** 每帧光线驱动：slot 输入为 null 时该侧光线不显示 */
  public updateBeams(
    dt: number,
    elapsed: number,
    inputs: [BeamFrameInput | null, BeamFrameInput | null],
  ) {
    void dt
    for (let slot = 0; slot < 2; slot++) {
      const input = inputs[slot]
      const group = this.beamGroups[slot]!
      if (!input) {
        group.visible = false
        continue
      }
      group.visible = true
      const colorHex = input.isSuper ? 0xfacc15 : this.beamColors[slot]!
      const outerMat = this.beamOuters[slot]!.material as THREE.MeshBasicMaterial
      const impactMat = this.beamImpactOrbs[slot]!.material as THREE.MeshBasicMaterial
      outerMat.color.setHex(input.isSuper ? 0xfacc15 : colorHex)
      impactMat.color.setHex(input.isSuper ? 0xfef08a : colorHex)

      const pulse = 1 + Math.sin(elapsed * 42) * 0.14
      const baseR = input.isSuper ? 1.55 : 0.95
      const origin = input.segment[0].clone().lerp(input.segment[1], 0.58)
      const end = input.target.clone()
      const dir = end.clone().sub(origin)
      const dirLen = Math.max(0.01, dir.length())
      dir.normalize()
      // 光线从掌心快速前伸展开（约 0.17 秒铺满到对手），冲击球停留在当前展开端点
      const reveal = this.revealAccumulator(slot, dt)
      const shownLen = Math.max(baseR * 5, reveal * dirLen)
      const shown = origin.clone().addScaledVector(dir, Math.min(dirLen, shownLen))

      this.alignCylinder(this.beamCores[slot]!, origin, shown, baseR * 0.48 * pulse)
      this.alignCylinder(this.beamOuters[slot]!, origin, shown, baseR * 1.15 * pulse)

      this.beamFilaments[slot]!.forEach((f, idx) => {
        const t = (idx + 0.5) / this.beamFilaments[slot]!.length
        const startPt = input.segment[0].clone().lerp(input.segment[1], t)
        const ang = elapsed * 16 + idx * 1.05
        const offset = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang)).multiplyScalar(
          baseR * 0.55,
        )
        this.alignCylinder(f, startPt, shown.clone().add(offset), baseR * 0.12)
      })

      this.beamOriginOrbs[slot]!.position.copy(origin)
      this.beamOriginOrbs[slot]!.scale.setScalar(baseR * 0.9 + Math.sin(elapsed * 32) * 0.15)
      this.beamImpactOrbs[slot]!.position.copy(shown)
      this.beamImpactOrbs[slot]!.scale.setScalar(baseR * 1.35 + Math.cos(elapsed * 36) * 0.25)

      if (Math.random() < 0.75) {
        this.spawnBurst(shown, colorHex, 3, 24, input.isSuper ? 1.2 : 0.85)
      }
    }
  }

  /** 光线展开速度积累（首帧快速前伸，随后持续推进到目标） */
  private beamReveal: [number, number] = [0, 0]
  private revealAccumulator(slot: number, dt: number): number {
    this.beamReveal[slot] = Math.min(1, this.beamReveal[slot]! + dt * 6)
    return this.beamReveal[slot]!
  }

  public resetBeamReveal(slot: PlayerSlot) {
    this.beamReveal[slot] = 0
  }

  public removeProjectileAt(index: number) {
    const proj = this.projectiles[index]
    if (!proj) return
    this.group.remove(proj.mesh)
    proj.mesh.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const m = node as THREE.Mesh
        m.geometry.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.dispose()
      }
    })
    this.projectiles.splice(index, 1)
  }

  public update(dt: number) {
    // 光轮抛射物
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i]!
      proj.age += dt
      proj.pos.addScaledVector(proj.vel, dt)
      proj.mesh.position.copy(proj.pos)
      proj.mesh.rotation.z += dt * 26
      if (Math.random() < 0.3) {
        this.spawnBurst(proj.pos, SLOT_ACCENTS[proj.fromSlot]!, 1, 6, 0.5)
      }
      if (proj.hitTriggered || proj.age >= proj.maxAge) {
        this.removeProjectileAt(i)
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!
      p.life += dt
      if (p.life >= p.maxLife) {
        this.group.remove(p.mesh)
        ;(p.mesh.material as THREE.Material).dispose()
        this.particles.splice(i, 1)
        continue
      }
      p.vy -= p.gravity * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(0.1, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt
      const ratio = 1 - p.life / p.maxLife
      p.mesh.scale.setScalar(p.startScale * ratio)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = ratio
    }

    for (let i = this.impactRings.length - 1; i >= 0; i--) {
      const r = this.impactRings[i]!
      r.life += dt
      if (r.life >= r.maxLife) {
        this.group.remove(r.mesh)
        r.mesh.geometry.dispose()
        ;(r.mesh.material as THREE.Material).dispose()
        this.impactRings.splice(i, 1)
        continue
      }
      const t = r.life / r.maxLife
      const ease = 1 - Math.pow(1 - t, 3)
      r.mesh.scale.setScalar(0.4 + ease * r.maxRadius)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.95
    }

    for (let i = this.hitFlashes.length - 1; i >= 0; i--) {
      const f = this.hitFlashes[i]!
      f.life += dt
      if (f.life >= f.maxLife) {
        this.group.remove(f.mesh)
        ;(f.mesh.material as THREE.Material).dispose()
        this.hitFlashes.splice(i, 1)
        continue
      }
      const t = f.life / f.maxLife
      const grow = t < 0.3 ? t / 0.3 : 1
      f.mesh.scale.setScalar((0.5 + grow * 2.6) * f.startScale)
      ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - t, 2)
    }
  }

  public clearAllDynamic() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      this.removeProjectileAt(i)
    }
    for (const p of this.particles) {
      this.group.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
    }
    this.particles = []
    for (const r of this.impactRings) {
      this.group.remove(r.mesh)
      r.mesh.geometry.dispose()
      ;(r.mesh.material as THREE.Material).dispose()
    }
    this.impactRings = []
    for (const f of this.hitFlashes) {
      this.group.remove(f.mesh)
      ;(f.mesh.material as THREE.Material).dispose()
    }
    this.hitFlashes = []
    for (let slot = 0; slot < 2; slot++) {
      this.beamGroups[slot]!.visible = false
      this.shieldMeshes[slot]!.visible = false
      this.beamChargeOrbs[slot]!.visible = false
      this.discChargePreviews[slot]!.visible = false
    }
  }
}
