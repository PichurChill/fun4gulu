"""
暗夜特摄都市废墟 + 海港 + 高山 + 火山 11 套贴图级高精度 PBR 场景资产 Blender 5.2 无头生产脚本

特性升级：
- 彻底消灭零贴图纯色方块：内置 numpy 程序化烘焙并打包多套高精 PBR 贴图
  (风化混凝土 Albedo+Normal、玻璃幕墙多层内构窗格 Albedo+Emissive+Roughness、
   东京特摄商业霓虹灯箱、防卫队装甲车面板涂装、海港波纹集装箱 Albedo+Normal、玄武岩山岩 Normal)
- 都市 7 套精雕重制 + 海港龙门吊/波纹集装箱 + 山区防卫队雷达前哨 + 火山柱状节理玄武岩柱

坐标契约：
- 1 unit = 1m，底面严格接地 Blender Z = 0（Three.js Y = 0），水平居中 (0, 0)
- 正面朝向 Blender -Y（Three.js +Z）
"""

import math
import os
import random
import tempfile
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, Euler

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "ui", "public", "models", "ultraman", "city_hq")
os.makedirs(OUT_DIR, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def save_pack_tex(name: str, rgba: np.ndarray, tmp_dir: str, colorspace: str = "sRGB"):
    h, w, _ = rgba.shape
    tmp = bpy.data.images.new(f"_tmp_{name}", width=w, height=h, alpha=True)
    tmp.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).astype(np.float32).ravel())
    p = os.path.join(tmp_dir, f"{name}.png")
    tmp.filepath_raw = p
    tmp.file_format = "PNG"
    tmp.save()
    bpy.data.images.remove(tmp)
    img = bpy.data.images.load(p, check_existing=False)
    img.name = name
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def height_to_normal(hmap: np.ndarray, strength: float = 2.0) -> np.ndarray:
    gx = np.roll(hmap, -1, axis=1) - np.roll(hmap, 1, axis=1)
    gy = np.roll(hmap, -1, axis=0) - np.roll(hmap, 1, axis=0)
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(hmap, dtype=np.float32)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    h, w = hmap.shape
    out = np.ones((h, w, 4), dtype=np.float32)
    out[:, :, 0] = nx * inv * 0.5 + 0.5
    out[:, :, 1] = ny * inv * 0.5 + 0.5
    out[:, :, 2] = nz * inv * 0.5 + 0.5
    return out


def value_noise_2d(h: int, w: int, scale_y: int, scale_x: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    grid = rng.random((scale_y, scale_x), dtype=np.float32)
    ys = np.linspace(0, scale_y, h, endpoint=False)
    xs = np.linspace(0, scale_x, w, endpoint=False)
    y0 = np.floor(ys).astype(int) % scale_y
    x0 = np.floor(xs).astype(int) % scale_x
    y1 = (y0 + 1) % scale_y
    x1 = (x0 + 1) % scale_x
    fy = (ys - np.floor(ys))[:, None]
    fx = (xs - np.floor(xs))[None, :]
    fy = fy * fy * (3.0 - 2.0 * fy)
    fx = fx * fx * (3.0 - 2.0 * fx)
    v00 = grid[y0[:, None], x0[None, :]]
    v10 = grid[y0[:, None], x1[None, :]]
    v01 = grid[y1[:, None], x0[None, :]]
    v11 = grid[y1[:, None], x1[None, :]]
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy


def fbm_2d(h: int, w: int, base: int, seed: int) -> np.ndarray:
    acc = np.zeros((h, w), dtype=np.float32)
    amp = 0.5
    freq = base
    for k in range(4):
        acc += amp * value_noise_2d(h, w, freq, freq, seed + k * 37)
        freq = min(h // 2, freq * 2)
        amp *= 0.5
    return acc


def build_tex_bank(tmp_dir: str):
    """生成并打包本轮资产共享的 7 套程序化高清贴图"""
    bank = {}
    S = 256

    # 1. 风化建筑混凝土板缝 + 烟熏污渍 + 凹凸法线
    n1 = fbm_2d(S, S, 8, 11)
    n2 = fbm_2d(S, S, 32, 23)
    grime = fbm_2d(S, S, 4, 71)
    yy, xx = np.mgrid[0:S, 0:S]
    seam_h = ((yy % 32) < 2).astype(np.float32)
    seam_v = ((xx % 64) < 2).astype(np.float32)
    seams = np.maximum(seam_h, seam_v)
    height_c = np.clip(0.62 + (n1 - 0.5) * 0.25 + (n2 - 0.5) * 0.14 - seams * 0.35, 0, 1)
    albedo_c = np.ones((S, S, 4), dtype=np.float32)
    base_v = np.clip(0.11 + n1 * 0.08 + n2 * 0.04 - grime * 0.06 - seams * 0.05, 0.04, 0.35)
    albedo_c[:, :, 0] = base_v * 0.96
    albedo_c[:, :, 1] = base_v * 1.00
    albedo_c[:, :, 2] = base_v * 1.12
    bank["concrete_col"] = save_pack_tex("ConcreteCol", albedo_c, tmp_dir, "sRGB")
    bank["concrete_nrm"] = save_pack_tex("ConcreteNrm", height_to_normal(height_c, 2.4), tmp_dir, "Non-Color")

    # 2. 暗夜摩天楼玻璃幕墙多层次内构窗格（含冷暖办公室天花灯、百叶窗遮挡与楼板暗带）
    W, H = 256, 512
    win_col = np.zeros((H, W, 4), dtype=np.float32)
    win_em = np.zeros((H, W, 4), dtype=np.float32)
    win_col[:, :, 0] = 0.035
    win_col[:, :, 1] = 0.055
    win_col[:, :, 2] = 0.095
    win_col[:, :, 3] = 1.0
    win_em[:, :, 3] = 1.0

    rng = np.random.default_rng(404)
    cols, rows = 8, 16
    cw, ch = W // cols, H // rows
    for r in range(rows):
        floor_busy = rng.random() < 0.78
        for c in range(cols):
            x0, x1 = c * cw + 3, (c + 1) * cw - 3
            y0, y1 = r * ch + 5, (r + 1) * ch - 4
            # 玻璃反射渐变底色
            grad = np.linspace(0.05, 0.14, y1 - y0)[:, None]
            win_col[y0:y1, x0:x1, 0] = grad * 0.65
            win_col[y0:y1, x0:x1, 1] = grad * 0.95
            win_col[y0:y1, x0:x1, 2] = grad * 1.45
            if floor_busy and rng.random() < 0.56:
                warm = rng.random() < 0.65
                bright = rng.uniform(0.38, 0.95)
                blind = rng.uniform(0.15, 0.55) if rng.random() < 0.4 else 0.0
                vy_start = y0 + int((y1 - y0) * blind)
                # 顶部天花灯更亮，底部渐暗模拟真实办公空间纵深
                vgrad = np.linspace(0.45, 1.0, max(1, y1 - vy_start))[:, None]
                # 窗内桌椅/立柱剪影条
                col_shade = np.ones((1, x1 - x0), dtype=np.float32)
                if rng.random() < 0.5:
                    mid = (x1 - x0) // 2
                    col_shade[:, mid - 1 : mid + 2] = 0.35
                lum = bright * vgrad * col_shade
                if warm:
                    rgb = (1.0, 0.72, 0.34)
                else:
                    rgb = (0.45, 0.80, 1.0)
                for ch_i in range(3):
                    win_em[vy_start:y1, x0:x1, ch_i] = lum * rgb[ch_i]
                    win_col[vy_start:y1, x0:x1, ch_i] = np.maximum(
                        win_col[vy_start:y1, x0:x1, ch_i], lum * rgb[ch_i] * 0.32
                    )
    bank["facade_col"] = save_pack_tex("FacadeCol", win_col, tmp_dir, "sRGB")
    bank["facade_em"] = save_pack_tex("FacadeEm", win_em, tmp_dir, "sRGB")

    # 3. 特摄都市霓虹商业灯箱贴图（青/粉/琥珀三色高密发光招牌图案，彻底取代纯色条）
    def make_neon_sign(name, primary, secondary, seed):
        sw, sh = 128, 256
        img = np.zeros((sh, sw, 4), dtype=np.float32)
        img[:, :, 3] = 1.0
        # 深底色 + 外发光边框
        img[:, :, 0:3] = 0.04
        img[4:10, 4:-4, 0:3] = primary
        img[-10:-4, 4:-4, 0:3] = primary
        img[4:-4, 4:10, 0:3] = primary
        img[4:-4, -10:-4, 0:3] = primary
        # 内部横竖结构字块与灯管横纹（远看像真实的东京涩谷/新宿竖向霓虹灯牌）
        r2 = np.random.default_rng(seed)
        y = 22
        while y < sh - 28:
            bh = int(r2.integers(20, 34))
            if y + bh > sh - 18:
                break
            col = primary if r2.random() < 0.65 else secondary
            # 模拟汉字/片假名笔画格子
            for _ in range(4):
                rx0 = int(r2.integers(18, sw - 44))
                rw = int(r2.integers(18, sw - rx0 - 16))
                ry0 = int(r2.integers(y, y + bh - 6))
                rh = int(r2.integers(4, 9))
                img[ry0 : ry0 + rh, rx0 : rx0 + rw, 0:3] = col
            for _ in range(3):
                rx0 = int(r2.integers(20, sw - 26))
                rw = int(r2.integers(5, 10))
                img[y + 2 : y + bh - 2, rx0 : rx0 + rw, 0:3] = col
            y += bh + 12
        # 扫描线质感
        img[::4, :, 0:3] *= 0.82
        return save_pack_tex(name, img, tmp_dir, "sRGB")

    bank["neon_cyan"] = make_neon_sign("NeonSignCyan", (0.08, 0.92, 1.0), (0.95, 0.98, 1.0), 101)
    bank["neon_magenta"] = make_neon_sign("NeonSignMag", (1.0, 0.14, 0.56), (1.0, 0.78, 0.25), 202)
    bank["neon_amber"] = make_neon_sign("NeonSignAmb", (1.0, 0.54, 0.08), (1.0, 0.92, 0.55), 303)

    # 4. 集装箱波纹肋板法线与粗糙涂装
    corrug = np.sin(xx * (2.0 * math.pi / 16.0)) * 0.5 + 0.5
    corrug_n = height_to_normal(corrug * 0.7 + n2 * 0.15, 2.8)
    bank["container_nrm"] = save_pack_tex("ContainerNrm", corrug_n, tmp_dir, "Non-Color")

    # 5. 山岩/玄武岩柱裂纹凹凸法线
    rock_h = np.clip(fbm_2d(S, S, 6, 88) * 0.7 + fbm_2d(S, S, 24, 99) * 0.3, 0, 1)
    bank["rock_nrm"] = save_pack_tex("RockNrm", height_to_normal(rock_h, 3.2), tmp_dir, "Non-Color")

    return bank


def make_pbr_mat(
    name: str,
    color=(0.2, 0.2, 0.2),
    roughness=0.75,
    metallic=0.1,
    col_img=None,
    nrm_img=None,
    nrm_strength=0.9,
    em_img=None,
    em_color=None,
    em_strength=0.0,
    uv_scale=(1.0, 1.0),
):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic

    mapping = None
    if col_img or nrm_img or em_img:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (uv_scale[0], uv_scale[1], 1.0)
        nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])

    if col_img is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = col_img
        nt.links.new(mapping.outputs["Vector"], t.inputs["Vector"])
        # 与指定色相做轻度相乘，便于同一套风化纹理复用深灰/中灰/战损色调
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (*color, 1.0)
        nt.links.new(t.outputs["Color"], mix.inputs["A"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])

    if nrm_img is not None:
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = nrm_img
        nt.links.new(mapping.outputs["Vector"], tn.inputs["Vector"])
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = nrm_strength
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    if em_img is not None and em_strength > 0:
        te = nt.nodes.new("ShaderNodeTexImage")
        te.image = em_img
        nt.links.new(mapping.outputs["Vector"], te.inputs["Vector"])
        nt.links.new(te.outputs["Color"], bsdf.inputs["Emission Color"])
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = em_strength
    elif em_color is not None and em_strength > 0:
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*em_color, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = em_strength

    return mat


def build_palette(bank):
    return {
        "concrete_dark": make_pbr_mat(
            "ConcreteDarkPBR", (0.72, 0.76, 0.84), 0.86, 0.06,
            col_img=bank["concrete_col"], nrm_img=bank["concrete_nrm"], nrm_strength=1.1, uv_scale=(1.4, 1.4)
        ),
        "concrete_mid": make_pbr_mat(
            "ConcreteMidPBR", (1.0, 1.0, 1.0), 0.84, 0.06,
            col_img=bank["concrete_col"], nrm_img=bank["concrete_nrm"], nrm_strength=1.0, uv_scale=(1.2, 1.2)
        ),
        "concrete_broken": make_pbr_mat(
            "ConcreteBrokenPBR", (0.88, 0.82, 0.78), 0.92, 0.05,
            col_img=bank["concrete_col"], nrm_img=bank["concrete_nrm"], nrm_strength=1.45, uv_scale=(1.8, 1.8)
        ),
        "facade_glass": make_pbr_mat(
            "FacadeGlassInteriorPBR", (1.0, 1.0, 1.0), 0.14, 0.76,
            col_img=bank["facade_col"], em_img=bank["facade_em"], em_strength=0.78, uv_scale=(1.0, 1.0)
        ),
        "steel_frame": make_pbr_mat("SteelFramePBR", (0.08, 0.10, 0.14), 0.36, 0.82, nrm_img=bank["concrete_nrm"], nrm_strength=0.35),
        "steel_rust": make_pbr_mat("SteelRustPBR", (0.24, 0.10, 0.06), 0.76, 0.48, nrm_img=bank["rock_nrm"], nrm_strength=0.8),
        "glass_dark": make_pbr_mat("GlassDarkPBR", (0.04, 0.07, 0.13), 0.10, 0.88),
        "win_warm": make_pbr_mat("WindowWarmPBR", (0.08, 0.06, 0.03), 0.22, 0.1, em_color=(1.0, 0.70, 0.28), em_strength=0.68),
        "neon_cyan": make_pbr_mat("NeonCyanSignPBR", (0.12, 0.2, 0.24), 0.18, 0.1, em_img=bank["neon_cyan"], em_strength=1.22),
        "neon_amber": make_pbr_mat("NeonAmberSignPBR", (0.2, 0.12, 0.04), 0.18, 0.1, em_img=bank["neon_amber"], em_strength=1.18),
        "neon_magenta": make_pbr_mat("NeonMagSignPBR", (0.2, 0.06, 0.14), 0.18, 0.1, em_img=bank["neon_magenta"], em_strength=1.22),
        "neon_strip_cyan": make_pbr_mat("NeonStripCyan", (0.03, 0.14, 0.18), 0.2, 0.1, em_color=(0.06, 0.88, 1.0), em_strength=1.15),
        "beacon_red": make_pbr_mat("BeaconRedPBR", (0.14, 0.01, 0.01), 0.2, 0.1, em_color=(1.0, 0.08, 0.06), em_strength=1.5),
        "lamp_glow": make_pbr_mat("LampGlowPBR", (0.14, 0.10, 0.04), 0.18, 0.05, em_color=(1.0, 0.76, 0.34), em_strength=1.25),
        "car_body": make_pbr_mat("GutsArmorWhitePBR", (0.58, 0.62, 0.68), 0.32, 0.56),
        "car_stripe": make_pbr_mat("GutsStripeOrangePBR", (0.86, 0.30, 0.06), 0.34, 0.26),
        "tire_rubber": make_pbr_mat("TireRubberPBR", (0.04, 0.04, 0.05), 0.90, 0.04),
        "siren_blue": make_pbr_mat("SirenBluePBR", (0.02, 0.08, 0.18), 0.15, 0.1, em_color=(0.08, 0.52, 1.0), em_strength=1.45),
        # 海港 / 山区 / 火山专用 PBR
        "crane_red": make_pbr_mat("CraneRedPBR", (0.68, 0.12, 0.09), 0.42, 0.52, nrm_img=bank["concrete_nrm"], nrm_strength=0.4),
        "crane_white": make_pbr_mat("CraneWhitePBR", (0.76, 0.78, 0.80), 0.46, 0.35),
        "cont_red": make_pbr_mat("ContainerRedPBR", (0.56, 0.11, 0.09), 0.58, 0.42, nrm_img=bank["container_nrm"], nrm_strength=1.25),
        "cont_blue": make_pbr_mat("ContainerBluePBR", (0.10, 0.26, 0.54), 0.58, 0.42, nrm_img=bank["container_nrm"], nrm_strength=1.25),
        "cont_amber": make_pbr_mat("ContainerAmberPBR", (0.68, 0.38, 0.08), 0.58, 0.42, nrm_img=bank["container_nrm"], nrm_strength=1.25),
        "cont_teal": make_pbr_mat("ContainerTealPBR", (0.09, 0.34, 0.36), 0.58, 0.42, nrm_img=bank["container_nrm"], nrm_strength=1.25),
        "mountain_rock": make_pbr_mat("MountainRockPBR", (0.28, 0.29, 0.27), 0.90, 0.05, nrm_img=bank["rock_nrm"], nrm_strength=1.45),
        "pine_foliage": make_pbr_mat("PineFoliagePBR", (0.08, 0.21, 0.11), 0.85, 0.02),
        "pine_trunk": make_pbr_mat("PineTrunkPBR", (0.19, 0.13, 0.08), 0.92, 0.02),
        "basalt_rock": make_pbr_mat("BasaltRockPBR", (0.11, 0.10, 0.11), 0.82, 0.16, nrm_img=bank["rock_nrm"], nrm_strength=1.65),
        "lava_crack": make_pbr_mat("LavaCrackPBR", (0.35, 0.05, 0.01), 0.35, 0.05, em_color=(1.0, 0.32, 0.04), em_strength=1.65),
    }


def add_box(bm, center, size, mat_idx=0, rot_euler=None, bevel_width=0.0):
    mat = Matrix.Translation(center)
    if rot_euler is not None:
        mat = mat @ Euler(rot_euler, "XYZ").to_matrix().to_4x4()
    mat = mat @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    ret = bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
    verts = ret["verts"]
    faces = list({f for v in verts for f in v.link_faces})
    for f in faces:
        f.material_index = mat_idx
    if bevel_width > 0.0:
        edges = list({e for f in faces for e in f.edges})
        bmesh.ops.bevel(
            bm, geom=edges, offset=bevel_width, segments=1, affect="EDGES", clamp_overlap=True
        )
    return verts


def add_cylinder(bm, center, radius, depth, segments=14, mat_idx=0, rot_euler=None, r2=None):
    mat = Matrix.Translation(center)
    if rot_euler is not None:
        mat = mat @ Euler(rot_euler, "XYZ").to_matrix().to_4x4()
    ret = bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius if r2 is None else r2, depth=depth, matrix=mat
    )
    verts = ret["verts"]
    for v in verts:
        for f in v.link_faces:
            f.material_index = mat_idx
    return verts


def add_rock_chunk(bm, center, scale, rng, mat_idx=0, subdiv=2):
    ret = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=0.5)
    verts = ret["verts"]
    planes = []
    for _ in range(5):
        n = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized()
        d = rng.uniform(0.24, 0.42)
        planes.append((n, d))
    rot = Euler((rng.uniform(0, 6.28), rng.uniform(0, 6.28), rng.uniform(0, 6.28)), "XYZ").to_matrix()
    for v in verts:
        p = v.co.copy()
        for n, d in planes:
            dot = p.dot(n)
            if dot > d:
                p -= n * (dot - d) * 0.88
        p.x *= scale[0] * rng.uniform(0.92, 1.08)
        p.y *= scale[1] * rng.uniform(0.92, 1.08)
        p.z *= scale[2] * rng.uniform(0.92, 1.08)
        v.co = Vector(center) + (rot @ p)
    for v in verts:
        for f in v.link_faces:
            f.material_index = mat_idx
    return verts


def apply_box_uv(mesh, tile_scale: float = 0.12):
    """三平面盒投影 UV 生成（确保所有程序化网格都拥有无拉伸 PBR 贴图坐标）"""
    uv_layer = mesh.uv_layers.new(name="UVMap") if not mesh.uv_layers else mesh.uv_layers.active
    verts = mesh.vertices
    for poly in mesh.polygons:
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            co = verts[mesh.loops[li].vertex_index].co
            if az >= ax and az >= ay:
                u, v = co.x * tile_scale, co.y * tile_scale
            elif ax >= ay:
                u, v = co.y * tile_scale, co.z * tile_scale
            else:
                u, v = co.x * tile_scale, co.z * tile_scale
            uv_layer.data[li].uv = (u, v)


def apply_exact_panel_uv(mesh, mat_indices_set):
    """为霓虹广告牌/玻璃立面赋予规整 0~1 贴合 UV，确保招牌排版完整对齐"""
    uv_layer = mesh.uv_layers.active
    verts = mesh.vertices
    for poly in mesh.polygons:
        if poly.material_index not in mat_indices_set:
            continue
        coords = [verts[mesh.loops[li].vertex_index].co for li in poly.loop_indices]
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        us, vs = [], []
        for c in coords:
            if az >= ax and az >= ay:
                us.append(c.x); vs.append(c.y)
            elif ax >= ay:
                us.append(c.y); vs.append(c.z)
            else:
                us.append(c.x); vs.append(c.z)
        u0, u1 = min(us), max(us)
        v0, v1 = min(vs), max(vs)
        du = max(1e-4, u1 - u0)
        dv = max(1e-4, v1 - v0)
        for idx_l, li in enumerate(poly.loop_indices):
            uv_layer.data[li].uv = ((us[idx_l] - u0) / du, (vs[idx_l] - v0) / dv)


def finalize_and_export(bm, name, materials, out_filename, uv_tile=0.12, exact_uv_mats=None):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    bmesh.ops.dissolve_degenerate(bm, dist=0.0005, edges=bm.edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if len(bm.verts) > 0:
        xs = [v.co.x for v in bm.verts]
        ys = [v.co.y for v in bm.verts]
        zs = [v.co.z for v in bm.verts]
        cx = (min(xs) + max(xs)) * 0.5
        cy = (min(ys) + max(ys)) * 0.5
        min_z = min(zs)
        for v in bm.verts:
            v.co.x -= cx
            v.co.y -= cy
            v.co.z -= min_z

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    for m in materials:
        mesh.materials.append(m)

    used_slots = {p.material_index for p in mesh.polygons}
    remap = {}
    if len(used_slots) < len(materials):
        orig_indices = [p.material_index for p in mesh.polygons]
        new_mats = []
        for idx, m in enumerate(materials):
            if idx in used_slots:
                remap[idx] = len(new_mats)
                new_mats.append(m)
        # 必须先重建材质槽，再写 polygon.material_index（Blender clear() 会将所有面索引重置为 0）
        mesh.materials.clear()
        for m in new_mats:
            mesh.materials.append(m)
        for p, oi in zip(mesh.polygons, orig_indices):
            p.material_index = remap[oi]
    else:
        remap = {i: i for i in range(len(materials))}

    apply_box_uv(mesh, tile_scale=uv_tile)
    if exact_uv_mats:
        mapped_exact = {remap[i] for i in exact_uv_mats if i in remap}
        apply_exact_panel_uv(mesh, mapped_exact)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mesh.polygons.foreach_set("use_smooth", [False] * len(mesh.polygons))

    out_path = os.path.join(OUT_DIR, out_filename)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_materials="EXPORT",
        use_selection=True,
    )
    size_kb = os.path.getsize(out_path) / 1024.0
    print(f"[Exported] {out_filename:28s} | polys={len(mesh.polygons):5d} | mats={len(mesh.materials):2d} | size={size_kb:6.1f} KB")


def add_curtain_wall_section(bm, w, d, z_start, z_end, floor_h, idx_facade, idx_frame):
    """凹嵌式内构玻璃幕墙 + 真实外凸结构竖挺与层间金属腰线（用多层内构纹理取代大量死板小色块）"""
    h = z_end - z_start
    zc = (z_start + z_end) * 0.5
    # 主幕墙玻璃芯体（贴内构视差夜灯纹理）
    add_box(bm, (0, 0, zc), (w, d, h), idx_facade)

    # 层间横向金属反光腰线
    floors = max(1, int(h / floor_h))
    for fi in range(floors + 1):
        z = z_start + fi * (h / floors)
        add_box(bm, (0, 0, z), (w + 0.34, d + 0.34, 0.28), idx_frame)

    # 四角加强结构钢柱 + 立面竖向幕墙肋挺
    cols_x = max(3, int(w / 2.6))
    cols_y = max(3, int(d / 2.6))
    for sx in (-1, 1):
        for sy in (-1, 1):
            add_box(bm, (sx * (w * 0.5 + 0.06), sy * (d * 0.5 + 0.06), zc), (0.58, 0.58, h), idx_frame)
    for ci in range(1, cols_x):
        x = -w * 0.5 + ci * (w / cols_x)
        for sy in (-1, 1):
            add_box(bm, (x, sy * (d * 0.5 + 0.1), zc), (0.22, 0.24, h), idx_frame)
    for ci in range(1, cols_y):
        y = -d * 0.5 + ci * (d / cols_y)
        for sx in (-1, 1):
            add_box(bm, (sx * (w * 0.5 + 0.1), y, zc), (0.24, 0.22, h), idx_frame)


# ==================== 1~7. 暗夜特摄都市高精资产 ====================

def build_tower_glass_hq(bank):
    pal = build_palette(bank)
    mats = [
        pal["concrete_dark"],   # 0
        pal["steel_frame"],     # 1
        pal["facade_glass"],    # 2
        pal["win_warm"],        # 3
        pal["concrete_mid"],    # 4
        pal["beacon_red"],      # 5
        pal["neon_strip_cyan"], # 6
    ]
    bm = bmesh.new()

    # 挑高金融大厦柱廊裙楼（0~6.4m）
    add_box(bm, (0, 0, 3.2), (14.6, 14.6, 6.4), 0, bevel_width=0.08)
    for px in (-5.8, -2.9, 0.0, 2.9, 5.8):
        add_box(bm, (px, -7.55, 3.0), (0.68, 0.68, 6.0), 4, bevel_width=0.04)
        add_box(bm, (px, 7.55, 3.0), (0.68, 0.68, 6.0), 4, bevel_width=0.04)
    add_box(bm, (0, -7.8, 6.1), (13.6, 2.1, 0.5), 1, bevel_width=0.06)
    add_box(bm, (0, -7.35, 3.0), (11.6, 0.18, 5.0), 3)

    # 下段核心塔楼（6.4~31m）
    add_curtain_wall_section(bm, 13.0, 13.0, 6.4, 31.0, 3.1, 2, 1)
    # 退台冠带与发光腰带（31~32.2m）
    add_box(bm, (0, 0, 31.6), (13.6, 13.6, 1.2), 1, bevel_width=0.08)
    add_box(bm, (0, 0, 31.6), (13.78, 13.78, 0.24), 6)

    # 上段退台塔楼（32.2~44.6m）
    add_curtain_wall_section(bm, 10.6, 10.6, 32.2, 44.6, 3.1, 2, 1)

    # 顶冠斜切架构 + 停机坪 + 屋顶冷却塔与钢桁架通信塔（44.6~54m）
    add_box(bm, (0, 0, 45.3), (11.2, 11.2, 1.4), 1, bevel_width=0.08)
    add_box(bm, (0, 0, 46.15), (9.0, 9.0, 0.35), 4)
    # 屋顶设备间 + 外露空调风管 + 双冷却塔
    add_box(bm, (-2.6, 2.2, 47.4), (3.6, 3.2, 2.2), 4, bevel_width=0.06)
    add_box(bm, (-2.6, -0.4, 46.8), (2.4, 1.4, 1.0), 1)
    add_cylinder(bm, (2.7, 2.4, 47.3), 1.1, 1.9, segments=16, mat_idx=1)
    add_cylinder(bm, (2.7, 0.0, 47.3), 1.1, 1.9, segments=16, mat_idx=1)
    # 锥形钢塔 + 十字微波雷达支架 + 航空警示灯
    add_cylinder(bm, (0, 0, 50.2), 0.42, 7.6, segments=10, mat_idx=1, r2=0.08)
    for hz in (48.4, 50.4, 52.0):
        span = 3.0 - (hz - 48.4) * 0.45
        add_box(bm, (0, 0, hz), (span, 0.22, 0.22), 1)
        add_box(bm, (0, 0, hz), (0.22, span, 0.22), 1)
    add_cylinder(bm, (0, 0, 54.15), 0.32, 0.48, segments=12, mat_idx=5)

    finalize_and_export(bm, "TowerGlassHQ", mats, "tower_glass_hq.glb", uv_tile=0.085)


def build_tower_cyber_neon(bank):
    pal = build_palette(bank)
    mats = [
        pal["concrete_dark"],   # 0
        pal["steel_frame"],     # 1
        pal["facade_glass"],    # 2
        pal["neon_cyan"],       # 3
        pal["neon_amber"],      # 4
        pal["neon_magenta"],    # 5
        pal["beacon_red"],      # 6
        pal["concrete_mid"],    # 7
        pal["neon_strip_cyan"], # 8
    ]
    bm = bmesh.new()

    # 商业裙楼（0~9.2m）
    add_curtain_wall_section(bm, 13.6, 13.6, 0.4, 9.2, 2.9, 2, 1)
    add_box(bm, (0, 0, 0.4), (14.2, 14.2, 0.8), 0)
    # 裙楼巨幅商业发光横牌
    add_box(bm, (0, -7.1, 4.6), (11.8, 0.4, 1.5), 1, bevel_width=0.04)
    add_box(bm, (0, -7.32, 4.6), (11.0, 0.14, 1.16), 4)
    add_box(bm, (7.1, 0, 4.6), (0.4, 11.8, 1.5), 1, bevel_width=0.04)
    add_box(bm, (7.32, 0, 4.6), (0.14, 11.0, 1.16), 3)

    # 主塔楼（9.2~37.2m）
    add_curtain_wall_section(bm, 11.6, 11.6, 9.2, 37.2, 3.1, 2, 1)

    # 外挂日系特摄竖向商业霓虹灯箱群（精确贴合 UV）
    sign_specs = [
        (-6.45, -3.2, 21.5, (0.58, 2.5, 14.2), 3),
        (6.45, 2.8, 24.5, (0.58, 2.3, 12.2), 5),
        (-3.2, -6.45, 25.5, (2.4, 0.58, 12.8), 4),
        (3.4, 6.45, 21.0, (2.4, 0.58, 12.2), 3),
    ]
    for sx, sy, sz, dim, glow_idx in sign_specs:
        add_box(bm, (sx, sy, sz), dim, 1, bevel_width=0.04)
        inner = (
            dim[0] * 1.08 if dim[0] < dim[1] else dim[0] * 0.84,
            dim[1] * 1.08 if dim[1] < dim[0] else dim[1] * 0.84,
            dim[2] * 0.9,
        )
        add_box(bm, (sx, sy, sz), inner, glow_idx)
        for dz in (-0.36, 0.0, 0.36):
            add_box(bm, (sx * 0.93, sy * 0.93, sz + dim[2] * dz), (0.95, 0.95, 0.24), 1)

    # 外挂消防金属楼梯剪影
    for st in range(7):
        z = 11.0 + st * 3.4
        add_box(bm, (6.05, -2.8, z), (0.75, 2.2, 0.14), 1)
        add_box(bm, (6.05, -1.6, z + 1.6), (0.5, 2.6, 0.12), 1, rot_euler=(0.75, 0, 0))

    # 屋顶设备房 + 大型发光广告架 + 双航空灯
    add_box(bm, (0, 0, 37.8), (12.2, 12.2, 1.2), 7, bevel_width=0.06)
    add_box(bm, (0, 2.4, 39.4), (6.6, 4.4, 2.4), 7)
    add_box(bm, (0, -4.6, 40.8), (9.6, 0.5, 4.2), 1)
    add_box(bm, (0, -4.9, 40.8), (8.8, 0.14, 3.5), 5)
    for bx in (-5.4, 5.4):
        add_cylinder(bm, (bx, -5.4, 39.1), 0.13, 1.4, segments=8, mat_idx=1)
        add_cylinder(bm, (bx, -5.4, 39.9), 0.24, 0.36, segments=10, mat_idx=6)

    finalize_and_export(
        bm, "TowerCyberNeon", mats, "tower_cyber_neon.glb",
        uv_tile=0.09, exact_uv_mats={3, 4, 5},
    )


def build_building_ruined_hq(bank):
    pal = build_palette(bank)
    mats = [
        pal["concrete_dark"],    # 0
        pal["concrete_broken"],  # 1
        pal["steel_frame"],      # 2
        pal["steel_rust"],       # 3
        pal["facade_glass"],     # 4
        pal["concrete_mid"],     # 5
        pal["win_warm"],         # 6
    ]
    bm = bmesh.new()
    rng = random.Random(303)

    # 底层战损完好段（0~13m）
    add_curtain_wall_section(bm, 12.6, 11.4, 0.2, 13.0, 3.1, 4, 2)

    # 中上段遭怪兽击毁露出的楼板、柱网与锯齿破墙（13~24m）
    floor_zs = [13.2, 16.2, 19.2, 22.2]
    for fi, z in enumerate(floor_zs):
        w_slab = 12.4 - fi * 2.0
        x_center = -fi * 0.95
        add_box(
            bm, (x_center, 0.0, z), (w_slab, 11.4, 0.52), 5,
            rot_euler=(rng.uniform(-0.04, 0.04), -0.035 * fi, 0.0), bevel_width=0.04
        )
        if fi < len(floor_zs) - 1:
            z_mid = z + 1.5
            add_box(bm, (x_center - w_slab * 0.5 + 0.35, 0.0, z_mid), (0.68, 11.0, 2.8), 0)
            for sy in (-5.4, 5.4):
                col_cnt = max(2, int(w_slab / 2.6))
                for ci in range(col_cnt + 1):
                    cx = (x_center - w_slab * 0.5 + 0.4) + ci * ((w_slab - 0.8) / col_cnt)
                    add_box(bm, (cx, sy, z_mid), (0.5, 0.5, 2.8), 1)
                add_box(bm, (x_center, sy, z + 0.55), (w_slab, 0.42, 0.72), 1)
            add_box(bm, (x_center - 0.6, 0.4, z_mid), (max(2.4, w_slab * 0.55), 5.2, 2.7), 0)
            # 室内幸存的一两处昏黄残灯
            if fi == 0:
                add_box(bm, (x_center - 1.2, -2.5, z + 2.4), (2.2, 0.4, 0.18), 6)

    fracture_anchors = [
        (-5.2, -4.8, 23.2), (-2.6, -4.6, 22.8), (-1.4, 1.8, 22.6),
        (0.6, -4.8, 19.6), (2.4, -2.2, 16.6), (4.6, 2.2, 16.5),
        (-3.6, 4.8, 22.6), (2.2, 4.6, 19.6),
    ]
    for fx, fy, fz in fracture_anchors:
        add_rock_chunk(bm, (fx, fy, fz - 0.35), (2.3, 1.9, 1.6), rng, 1)
        for _ in range(5):
            rx = fx + rng.uniform(-0.75, 0.75)
            ry = fy + rng.uniform(-0.75, 0.75)
            length = rng.uniform(1.5, 3.0)
            add_cylinder(
                bm, (rx, ry, fz + length * 0.36), 0.055, length, segments=6, mat_idx=3,
                rot_euler=(rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), 0),
            )

    for _ in range(22):
        ang = rng.uniform(0, math.pi * 2)
        rad = rng.uniform(5.8, 7.8)
        sx, sy, sz = rng.uniform(1.2, 2.6), rng.uniform(1.0, 2.2), rng.uniform(0.7, 1.8)
        add_rock_chunk(bm, (math.cos(ang) * rad, math.sin(ang) * rad, sz * 0.36), (sx, sy, sz), rng, 1)

    finalize_and_export(bm, "BuildingRuinedHQ", mats, "building_ruined_hq.glb", uv_tile=0.11)


def build_overpass_broken(bank):
    pal = build_palette(bank)
    mats = [
        pal["concrete_mid"],    # 0
        pal["concrete_broken"], # 1
        pal["concrete_dark"],   # 2
        pal["steel_frame"],     # 3
        pal["steel_rust"],      # 4
    ]
    bm = bmesh.new()
    rng = random.Random(404)

    # T 型双柱重型桥墩 + 抗震托座
    add_box(bm, (0, -4.2, 0.65), (6.0, 3.4, 1.3), 1, bevel_width=0.08)
    add_box(bm, (-1.85, -4.2, 4.4), (1.4, 1.6, 7.0), 0, bevel_width=0.06)
    add_box(bm, (1.85, -4.2, 4.4), (1.4, 1.6, 7.0), 0, bevel_width=0.06)
    add_box(bm, (0, -4.2, 8.2), (8.4, 2.2, 1.3), 0, bevel_width=0.08)

    # 完好半段箱梁 + 防撞墙 + 路灯残柱
    add_box(bm, (0, -4.2, 9.35), (8.8, 7.2, 1.12), 0, bevel_width=0.06)
    add_box(bm, (0, -4.2, 9.96), (7.8, 7.2, 0.14), 2)
    for sx in (-4.15, 4.15):
        add_box(bm, (sx, -4.2, 10.35), (0.44, 7.2, 0.94), 0, bevel_width=0.05)
        add_box(bm, (sx, -4.2, 10.94), (0.14, 7.2, 0.14), 3)

    # 折断砸入地面的倾斜箱梁（实打实接地）
    slope_rot = (-0.75, 0.0, 0.0)
    add_box(bm, (0.0, 3.9, 4.75), (8.6, 12.2, 1.08), 1, rot_euler=slope_rot, bevel_width=0.06)
    rot_m = Euler(slope_rot, "XYZ").to_matrix()
    for sx in (-4.0, 4.0):
        guard_ctr = Vector((0.0, 3.9, 4.75)) + (rot_m @ Vector((sx, 0.0, 0.92)))
        add_box(bm, tuple(guard_ctr), (0.42, 12.0, 0.88), 1, rot_euler=slope_rot)
    for _ in range(20):
        sz = rng.uniform(0.65, 1.65)
        add_rock_chunk(
            bm,
            (rng.uniform(-4.8, 4.8), rng.uniform(6.2, 9.8), sz * 0.36),
            (rng.uniform(1.0, 2.4), rng.uniform(0.9, 2.1), sz),
            rng, 1,
        )

    for rx in (-3.6, -2.4, -1.2, 0.0, 1.2, 2.4, 3.6):
        for k in range(2):
            add_cylinder(
                bm, (rx + k * 0.28, -0.4, 9.25 - k * 0.28), 0.06, 2.3, segments=6, mat_idx=4,
                rot_euler=(math.pi * 0.5 + rng.uniform(-0.32, 0.36), rng.uniform(-0.22, 0.22), 0),
            )

    finalize_and_export(bm, "OverpassBroken", mats, "overpass_broken.glb", uv_tile=0.14)


def build_rubble_cluster_hq(bank):
    pal = build_palette(bank)
    mats = [
        pal["concrete_broken"], # 0
        pal["concrete_mid"],    # 1
        pal["steel_rust"],      # 2
        pal["steel_frame"],     # 3
    ]
    bm = bmesh.new()
    rng = random.Random(505)

    wall_pivot = Vector((-0.3, 0.2, 0.0))
    wall_rot = Euler((0.14, -0.22, 0.22), "XYZ")
    wm = wall_rot.to_matrix()
    def add_wall_part(local_ctr, sz, mat_i):
        p = wall_pivot + (wm @ Vector(local_ctr))
        add_box(bm, tuple(p), sz, mat_i, rot_euler=wall_rot, bevel_width=0.05)

    add_wall_part((0.0, 0.0, 0.65), (4.0, 0.58, 1.3), 1)
    add_wall_part((-1.45, 0.0, 1.95), (1.1, 0.58, 1.35), 1)
    add_wall_part((1.45, 0.0, 1.95), (1.1, 0.58, 1.35), 1)
    add_wall_part((-0.25, 0.0, 2.95), (3.5, 0.58, 0.72), 1)
    add_wall_part((0.0, 0.0, 1.32), (1.85, 0.62, 0.1), 3)
    add_wall_part((-0.88, 0.0, 1.95), (0.1, 0.62, 1.25), 3)
    add_box(bm, (1.1, -0.5, 1.25), (0.32, 4.0, 0.32), 3, rot_euler=(0.56, 0.12, -0.48))

    for i in range(9):
        local_p = Vector((-1.6 + i * 0.4, 0.0, 3.45))
        wp = wall_pivot + (wm @ local_p)
        add_cylinder(
            bm, tuple(wp), 0.042, rng.uniform(0.95, 1.9), segments=6, mat_idx=2,
            rot_euler=(rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45), 0),
        )

    for _ in range(20):
        ang = rng.uniform(0, math.pi * 2)
        rad = rng.uniform(0.45, 2.9)
        sx, sy, sz = rng.uniform(0.7, 1.9), rng.uniform(0.65, 1.7), rng.uniform(0.48, 1.3)
        add_rock_chunk(bm, (math.cos(ang) * rad, math.sin(ang) * rad, sz * 0.34), (sx, sy, sz), rng, 0)

    finalize_and_export(bm, "RubbleClusterHQ", mats, "rubble_cluster_hq.glb", uv_tile=0.22)


def build_street_props_hq(bank):
    """精细都市街景配景：弧形双臂路灯 + 三色遮光红绿灯 + 消防栓 + 配电箱 + 金属护栏"""
    pal = build_palette(bank)
    mats = [
        pal["steel_frame"],     # 0
        pal["concrete_mid"],    # 1
        pal["lamp_glow"],       # 2
        pal["beacon_red"],      # 3
        pal["lamp_glow"],       # 4 交通信号黄灯（纯琥珀高亮，避免贴招牌纹理）
        pal["neon_strip_cyan"], # 5
    ]
    bm = bmesh.new()

    # 混凝土八角基座与金属法兰盘
    add_box(bm, (0, 0, 0.25), (0.78, 0.78, 0.5), 1, bevel_width=0.06)
    add_cylinder(bm, (0, 0, 0.54), 0.26, 0.08, segments=12, mat_idx=0)
    # 微倾锥形灯杆
    tilt = (0.03, -0.05, 0.0)
    add_cylinder(bm, (0, 0, 4.3), 0.15, 7.6, segments=14, mat_idx=0, rot_euler=tilt, r2=0.08)
    # 弧形折弯挑臂（分三段弯曲，消除生硬直棍感）
    add_cylinder(bm, (-0.52, 0, 7.82), 0.065, 1.15, segments=10, mat_idx=0, rot_euler=(0, math.pi * 0.42, 0))
    add_cylinder(bm, (-1.52, 0, 8.02), 0.06, 1.15, segments=10, mat_idx=0, rot_euler=(0, math.pi * 0.48, 0))
    # 流线灯壳 + 高亮漫射灯罩
    add_box(bm, (-2.25, 0, 8.08), (0.86, 0.42, 0.18), 0, bevel_width=0.05)
    add_box(bm, (-2.25, 0, 7.96), (0.72, 0.30, 0.08), 2)

    # 带遮光帽檐的交通信号灯箱
    add_box(bm, (-0.82, 0, 5.55), (1.42, 0.12, 0.12), 0)
    add_box(bm, (-1.28, 0, 5.5), (0.42, 0.48, 1.24), 0, bevel_width=0.04)
    for dz, m_i in ((0.36, 3), (0.0, 4), (-0.36, 5)):
        add_cylinder(bm, (-1.28, -0.25, 5.5 + dz), 0.12, 0.06, segments=12, mat_idx=m_i, rot_euler=(math.pi * 0.5, 0, 0))
        add_box(bm, (-1.28, -0.32, 5.62 + dz), (0.28, 0.18, 0.04), 0)

    # 配电箱 + 消防栓 + 人行道防撞护栏
    add_box(bm, (0.88, 0.65, 0.68), (0.82, 0.66, 1.36), 1, bevel_width=0.05)
    add_box(bm, (0.88, 0.31, 0.72), (0.64, 0.04, 0.96), 0)
    add_cylinder(bm, (0.65, -0.95, 0.42), 0.14, 0.84, segments=10, mat_idx=3)
    add_cylinder(bm, (0.65, -0.95, 0.88), 0.18, 0.12, segments=10, mat_idx=3)
    for hy in (-1.4, 0.0, 1.4):
        add_box(bm, (-0.56, hy, 0.5), (0.09, 0.09, 1.0), 0, bevel_width=0.015)
    add_box(bm, (-0.56, 0.0, 0.92), (0.10, 2.9, 0.10), 0, bevel_width=0.015)
    add_box(bm, (-0.56, 0.0, 0.52), (0.10, 2.9, 0.08), 0, bevel_width=0.015)

    finalize_and_export(bm, "StreetPropsHQ", mats, "street_props_hq.glb", uv_tile=0.35)


def build_guts_vehicle_wreck(bank):
    """精雕防卫队特种装甲巡逻车（流线斜面装甲 + 轮拱 + 前绞盘保险杠 + 车顶侦察雷达与爆闪警灯）"""
    pal = build_palette(bank)
    mats = [
        pal["car_body"],     # 0
        pal["car_stripe"],   # 1
        pal["glass_dark"],   # 2
        pal["steel_frame"],  # 3
        pal["tire_rubber"],  # 4
        pal["beacon_red"],   # 5
        pal["siren_blue"],   # 6
        pal["lamp_glow"],    # 7
    ]
    bm = bmesh.new()

    # 下底盘与斜面引擎盖
    add_box(bm, (0, 0.05, 0.86), (2.18, 4.96, 0.78), 0, bevel_width=0.10)
    add_box(bm, (0, -1.68, 1.18), (1.92, 1.38, 0.34), 0, rot_euler=(0.14, 0, 0), bevel_width=0.08)
    # 侧裙橙红高速条纹与防擦装甲板
    add_box(bm, (0, 0.05, 0.92), (2.26, 4.58, 0.22), 1, bevel_width=0.02)
    for sx in (-1.08, 1.08):
        add_box(bm, (sx, 0.0, 0.56), (0.18, 2.1, 0.22), 3, bevel_width=0.03)
    # 装甲乘员舱（带前倾挡风玻璃与防滚架）
    add_box(bm, (0, 0.36, 1.62), (1.84, 2.58, 0.78), 0, bevel_width=0.12)
    add_box(bm, (0, -0.96, 1.56), (1.66, 0.14, 0.58), 2, rot_euler=(-0.34, 0, 0))
    add_box(bm, (0, 1.64, 1.58), (1.58, 0.14, 0.52), 2, rot_euler=(0.24, 0, 0))
    add_box(bm, (0, 0.36, 1.62), (1.90, 2.08, 0.46), 2)
    # 车窗立柱（A/B/C柱）
    for sx in (-0.94, 0.94):
        add_box(bm, (sx, 0.35, 1.62), (0.10, 0.14, 0.62), 3)
        add_box(bm, (sx, -0.78, 1.58), (0.10, 0.12, 0.62), 3, rot_euler=(-0.34, 0, 0))
        add_box(bm, (sx, 1.48, 1.58), (0.10, 0.14, 0.60), 3, rot_euler=(0.22, 0, 0))
    # 重型前防撞牛栏杠 + 拖车钩 + 进气格栅 + 四灯组
    add_box(bm, (0, -2.56, 0.68), (2.26, 0.36, 0.42), 3, bevel_width=0.06)
    add_box(bm, (0, -2.68, 1.04), (1.36, 0.12, 0.36), 3, bevel_width=0.02)
    add_box(bm, (0, 2.54, 0.68), (2.22, 0.32, 0.38), 3, bevel_width=0.05)
    add_box(bm, (0, -2.48, 0.98), (1.02, 0.08, 0.26), 3)
    for lx in (-0.76, 0.76):
        add_box(bm, (lx, -2.48, 1.02), (0.42, 0.12, 0.20), 7, bevel_width=0.02)
        add_box(bm, (lx, 2.50, 1.02), (0.38, 0.12, 0.18), 5, bevel_width=0.02)
    # 车顶红蓝防卫队爆闪灯排 + 尾部通信天线
    add_box(bm, (0, -0.02, 2.06), (1.24, 0.34, 0.12), 3, bevel_width=0.02)
    add_box(bm, (-0.36, -0.02, 2.18), (0.46, 0.26, 0.18), 5, bevel_width=0.03)
    add_box(bm, (0.36, -0.02, 2.18), (0.46, 0.26, 0.18), 6, bevel_width=0.03)
    add_cylinder(bm, (0.62, 1.38, 2.65), 0.03, 1.2, segments=8, mat_idx=3)

    # 4 只重型越野轮胎 + 轮眉 + 五辐轮毂
    for wx in (-1.08, 1.08):
        for wy in (-1.52, 1.52):
            add_box(bm, (wx * 0.96, wy, 0.92), (0.32, 1.12, 0.22), 3, bevel_width=0.04)
            add_cylinder(bm, (wx, wy, 0.50), 0.50, 0.38, segments=18, mat_idx=4, rot_euler=(0, math.pi * 0.5, 0))
            add_cylinder(bm, (wx * 1.03, wy, 0.50), 0.28, 0.40, segments=14, mat_idx=3, rot_euler=(0, math.pi * 0.5, 0))
            add_cylinder(bm, (wx * 1.05, wy, 0.50), 0.12, 0.42, segments=10, mat_idx=0, rot_euler=(0, math.pi * 0.5, 0))

    # 整体战损微倾 5°
    tilt_m = Euler((0.03, 0.08, 0.0), "XYZ").to_matrix()
    for v in bm.verts:
        v.co = tilt_m @ v.co

    finalize_and_export(bm, "GutsVehicleWreck", mats, "guts_vehicle_wreck.glb", uv_tile=0.45)


# ==================== 8~11. 海港 / 山区 / 火山高精场景资产 ====================

def build_port_gantry_crane(bank):
    """资产 8：海港码头红白涂装重型岸桥龙门吊（22×26×12m）"""
    pal = build_palette(bank)
    mats = [
        pal["crane_red"],    # 0
        pal["crane_white"],  # 1
        pal["steel_frame"],  # 2
        pal["beacon_red"],   # 3
        pal["lamp_glow"],    # 4
    ]
    bm = bmesh.new()

    # 四条斜撑门架主腿 + 底部走行台车（贯通至 z=18.2 承托顶部机房与悬臂）
    for sx in (-5.5, 5.5):
        for sy in (-4.8, 4.8):
            add_box(bm, (sx, sy, 0.9), (1.6, 2.2, 1.8), 2, bevel_width=0.05)
            add_box(bm, (sx * 0.92, sy * 0.92, 9.6), (0.95, 0.95, 17.4), 0, rot_euler=(sy * -0.010, sx * 0.012, 0), bevel_width=0.04)
    # 联系横梁 + 下/中/上三层结构平台
    for sy in (-4.8, 4.8):
        add_box(bm, (0, sy, 1.3), (11.2, 0.8, 0.9), 2)
    for hz in (8.6, 16.4):
        add_box(bm, (0, 0, hz), (10.8, 9.8, 0.85), 1, bevel_width=0.04)
    # 前伸悬臂大梁（z=17.4，紧贴上平台）与坐实于大梁之上的白色机械室（z=18.1~21.9）
    add_box(bm, (0, 2.2, 17.4), (2.4, 28.0, 1.4), 0, bevel_width=0.05)
    add_box(bm, (0, 0, 20.0), (8.4, 7.6, 3.8), 1, bevel_width=0.06)
    # A 字塔顶双立柱 + 顶部横梁（z=25.6）承托航空警示灯
    for sx in (-2.8, 2.8):
        add_box(bm, (sx, 0, 23.8), (0.72, 0.72, 4.2), 0, bevel_width=0.03)
    add_box(bm, (0, 0, 25.8), (6.4, 0.85, 0.72), 0, bevel_width=0.03)
    add_cylinder(bm, (0, 0, 26.45), 0.32, 0.56, segments=10, mat_idx=3)
    # 从塔顶横梁两端严格拉接至悬臂大梁前后锚点的四条斜拉钢索
    for sx in (-1.1, 1.1):
        p_top = Vector((sx, 0.0, 25.6))
        for p_end in (Vector((sx, 14.8, 18.0)), Vector((sx, -10.8, 18.0))):
            diff = p_end - p_top
            mid = (p_top + p_end) * 0.5
            q = Vector((0, 0, 1)).rotation_difference(diff.normalized())
            add_cylinder(bm, tuple(mid), 0.10, diff.length, segments=8, mat_idx=2, rot_euler=q.to_euler("XYZ"))
    # 司机操作室与探照灯（紧贴悬臂大梁底面 z=16.0）
    add_box(bm, (0, 11.2, 15.8), (2.4, 3.0, 1.85), 2, bevel_width=0.05)
    add_box(bm, (0, 12.75, 15.6), (1.6, 0.14, 0.8), 4)

    finalize_and_export(bm, "PortGantryCrane", mats, "port_gantry_crane.glb", uv_tile=0.14)


def build_port_containers_hq(bank):
    """资产 9：海港波纹肋板多色错层堆叠集装箱簇（13×7.5×12.6m）"""
    pal = build_palette(bank)
    mats = [
        pal["cont_red"],    # 0
        pal["cont_blue"],   # 1
        pal["cont_amber"],  # 2
        pal["cont_teal"],   # 3
        pal["steel_frame"], # 4
    ]
    bm = bmesh.new()

    def add_container(cx, cy, cz, rot_z, m_idx):
        # 40 尺集装箱比例：2.6 × 12.2 × 2.8m，带四角角件框架与端门锁定杆
        r = (0, 0, rot_z)
        add_box(bm, (cx, cy, cz), (2.6, 12.0, 2.72), m_idx, rot_euler=r, bevel_width=0.04)
        rm = Euler(r, "XYZ").to_matrix()
        for sx in (-1.32, 1.32):
            for sz in (-1.34, 1.34):
                p = Vector((cx, cy, cz)) + (rm @ Vector((sx, 0, sz)))
                add_box(bm, tuple(p), (0.14, 12.16, 0.14), 4, rot_euler=r)
            for sy in (-6.02, 6.02):
                p = Vector((cx, cy, cz)) + (rm @ Vector((sx, sy, 0)))
                add_box(bm, tuple(p), (0.16, 0.16, 2.8), 4, rot_euler=r)

    add_container(-3.0, 0.0, 1.4, 0.02, 0)
    add_container(0.0, 0.4, 1.4, -0.01, 1)
    add_container(3.1, -0.3, 1.4, 0.03, 3)
    add_container(-2.9, 0.2, 4.22, -0.02, 2)
    add_container(0.1, 0.3, 4.22, 0.01, 0)
    add_container(-2.85, 0.15, 7.04, 0.03, 1)

    finalize_and_export(bm, "PortContainersHQ", mats, "port_containers_hq.glb", uv_tile=0.22)


def build_mountain_radar_base(bank):
    """资产 10：山区防卫队山脊雷达前哨站 + 棱角岩礁 + 冷杉松树群"""
    pal = build_palette(bank)
    mats = [
        pal["mountain_rock"],   # 0
        pal["concrete_mid"],    # 1
        pal["steel_frame"],     # 2
        pal["pine_foliage"],    # 3
        pal["pine_trunk"],      # 4
        pal["beacon_red"],      # 5
        pal["neon_strip_cyan"], # 6
    ]
    bm = bmesh.new()
    rng = random.Random(606)

    # 棱角山岩基底
    add_rock_chunk(bm, (0, 0, 2.2), (12.5, 10.5, 5.2), rng, 0)
    add_rock_chunk(bm, (-5.2, 2.4, 1.8), (6.5, 5.8, 4.2), rng, 0)
    add_rock_chunk(bm, (5.4, -1.8, 1.6), (6.0, 5.5, 3.8), rng, 0)

    # 防卫队混凝土掩体基座 + 雷达塔楼 + 抛物面雷达锅
    add_box(bm, (0, 0, 5.2), (6.8, 6.2, 2.6), 1, bevel_width=0.08)
    add_box(bm, (0, -3.15, 5.4), (3.8, 0.14, 0.65), 6)
    add_cylinder(bm, (0, 0, 8.2), 1.8, 3.8, segments=12, mat_idx=1, r2=1.45)
    add_cylinder(bm, (0, -0.4, 11.4), 2.8, 0.5, segments=16, mat_idx=2, rot_euler=(1.12, 0, 0), r2=0.8)
    add_cylinder(bm, (0, -1.6, 12.1), 0.12, 2.2, segments=8, mat_idx=2, rot_euler=(1.12, 0, 0))
    add_cylinder(bm, (0, -2.5, 12.5), 0.24, 0.34, segments=10, mat_idx=5)

    # 周围多层次冷杉松树簇
    tree_spots = [(-6.8, -3.6, 1.1), (-8.4, 1.2, 1.3), (7.2, 2.6, 1.25), (6.5, -4.4, 0.95), (-4.2, 5.6, 1.15), (3.8, 5.4, 1.0)]
    for tx, ty, sc in tree_spots:
        add_cylinder(bm, (tx, ty, 1.5 * sc), 0.28 * sc, 3.0 * sc, segments=8, mat_idx=4, r2=0.14 * sc)
        for tier in range(3):
            z = (2.6 + tier * 1.45) * sc
            r1 = (2.1 - tier * 0.45) * sc
            add_cylinder(bm, (tx, ty, z), r1, 2.3 * sc, segments=9, mat_idx=3, r2=0.06)

    finalize_and_export(bm, "MountainRadarBase", mats, "mountain_radar_base.glb", uv_tile=0.16)


def build_volcano_basalt_spire(bank):
    """资产 11：火山六棱柱状节理玄武岩巨岩簇 + 炽热熔岩裂隙"""
    pal = build_palette(bank)
    mats = [
        pal["basalt_rock"], # 0
        pal["lava_crack"],  # 1
    ]
    bm = bmesh.new()
    rng = random.Random(707)

    # 六边形柱状节理玄武岩集群（标志性火山地质感）
    columns = [
        (0.0, 0.0, 2.6, 15.5, 0.05, -0.04),
        (-2.8, 1.2, 2.1, 11.2, 0.14, 0.08),
        (2.6, 1.5, 2.0, 10.4, -0.12, 0.06),
        (-1.8, -2.6, 1.9, 8.8, 0.1, -0.12),
        (2.4, -2.2, 2.2, 7.6, -0.14, -0.08),
        (-4.6, -0.8, 1.6, 6.2, 0.18, 0.1),
        (4.4, 0.2, 1.7, 5.8, -0.16, 0.12),
    ]
    for cx, cy, rad, h, rx, ry in columns:
        add_cylinder(bm, (cx, cy, h * 0.48), rad, h, segments=6, mat_idx=0, rot_euler=(rx, ry, rng.uniform(0, 1)), r2=rad * 0.72)

    # 底部炽热熔岩裂缝脉络
    for ang in (0.3, 1.6, 2.9, 4.4, 5.5):
        px, py = math.cos(ang) * 2.8, math.sin(ang) * 2.4
        add_box(bm, (px, py, 1.8), (0.38, 3.6, 2.2), 1, rot_euler=(0.15, 0.1, ang))

    for _ in range(14):
        ang = rng.uniform(0, math.pi * 2)
        dist = rng.uniform(2.6, 6.2)
        sz = rng.uniform(1.0, 2.4)
        add_rock_chunk(bm, (math.cos(ang) * dist, math.sin(ang) * dist, sz * 0.4), (sz * 1.4, sz * 1.3, sz), rng, 0)

    finalize_and_export(bm, "VolcanoBasaltSpire", mats, "volcano_basalt_spire.glb", uv_tile=0.14)


def main():
    with tempfile.TemporaryDirectory() as tmp_dir:
        # 每次 clear_scene 会清理 bpy.data.images，因此在每个构建前按需创建贴图组
        for fn in (
            build_tower_glass_hq,
            build_tower_cyber_neon,
            build_building_ruined_hq,
            build_overpass_broken,
            build_rubble_cluster_hq,
            build_street_props_hq,
            build_guts_vehicle_wreck,
            build_port_gantry_crane,
            build_port_containers_hq,
            build_mountain_radar_base,
            build_volcano_basalt_spire,
        ):
            clear_scene()
            bank = build_tex_bank(tmp_dir)
            fn(bank)
    print("=== ALL 11 PBR ARENA ASSETS EXPORTED ===")


if __name__ == "__main__":
    main()
