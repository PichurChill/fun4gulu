"""
暗夜特摄都市废墟 7 套高精度场景资产 Blender 5.2 无头参数化生产脚本

坐标与尺寸契约：
- 单位：1 unit = 1m
- 接地：所有资产底面严格对齐 Blender Z = 0（export_yup=True 导出后对应 Three.js Y = 0）
- 水平中心：对齐原点 (0, 0)
- 正面朝向：Blender -Y 为正立面（export_yup=True 后对应 Three.js +Z 面向主视角）

运行方式：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    -P art/ultraman_city/build_city_assets.py
"""

import math
import os
import random
import bpy
import bmesh
from mathutils import Matrix, Vector, Euler

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "ui", "public", "models", "ultraman", "city_hq")
os.makedirs(OUT_DIR, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def get_bsdf(mat):
    mat.use_nodes = True
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if out is None:
        out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def make_mat(name, color, roughness=0.75, metallic=0.1, emission=None, emission_strength=0.0):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name=name)
    bsdf = get_bsdf(mat)
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None and emission_strength > 0.0:
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_palette():
    """统一暗夜特摄都市电影级色板（压暗发光体漫反射底色以防直射光叠加漂白，窗格稳居 Bloom 下方、霓虹保高饱和）"""
    return {
        "concrete_dark": make_mat("ConcreteDark", (0.08, 0.09, 0.12), 0.88, 0.06),
        "concrete_mid": make_mat("ConcreteMid", (0.14, 0.15, 0.18), 0.86, 0.06),
        "concrete_broken": make_mat("ConcreteBroken", (0.13, 0.12, 0.12), 0.94, 0.04),
        "steel_frame": make_mat("SteelFrame", (0.07, 0.09, 0.13), 0.42, 0.74),
        "steel_rust": make_mat("SteelRust", (0.20, 0.09, 0.06), 0.80, 0.45),
        "glass_dark": make_mat("GlassDark", (0.04, 0.07, 0.13), 0.14, 0.84),
        "win_warm": make_mat("WindowWarm", (0.07, 0.05, 0.03), 0.25, 0.08, (1.0, 0.68, 0.26), 0.62),
        "win_cool": make_mat("WindowCool", (0.03, 0.06, 0.09), 0.22, 0.08, (0.28, 0.68, 1.0), 0.56),
        "neon_cyan": make_mat("NeonCyan", (0.03, 0.14, 0.18), 0.20, 0.10, (0.04, 0.86, 1.0), 1.08),
        "neon_amber": make_mat("NeonAmber", (0.18, 0.08, 0.02), 0.20, 0.10, (1.0, 0.42, 0.04), 1.05),
        "neon_magenta": make_mat("NeonMagenta", (0.16, 0.03, 0.10), 0.20, 0.10, (1.0, 0.08, 0.46), 1.08),
        "beacon_red": make_mat("BeaconRed", (0.14, 0.01, 0.01), 0.20, 0.10, (1.0, 0.08, 0.06), 1.48),
        "lamp_glow": make_mat("LampGlow", (0.14, 0.10, 0.04), 0.18, 0.05, (1.0, 0.74, 0.32), 1.18),
        "car_body": make_mat("GutsArmorWhite", (0.48, 0.52, 0.58), 0.36, 0.52),
        "car_stripe": make_mat("GutsStripeOrange", (0.82, 0.28, 0.06), 0.38, 0.25),
        "tire_rubber": make_mat("TireRubber", (0.04, 0.04, 0.05), 0.90, 0.04),
        "siren_blue": make_mat("SirenBlue", (0.02, 0.08, 0.18), 0.15, 0.10, (0.08, 0.50, 1.0), 1.38),
    }


def add_box(bm, center, size, mat_idx=0, rot_euler=None, bevel_width=0.0):
    """向 bmesh 添加一个带可选旋转和倒角的立方体"""
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
            bm,
            geom=edges,
            offset=bevel_width,
            segments=1,
            affect="EDGES",
            clamp_overlap=True,
        )
    return verts


def add_cylinder(bm, center, radius, depth, segments=12, mat_idx=0, rot_euler=None, r2=None):
    mat = Matrix.Translation(center)
    if rot_euler is not None:
        mat = mat @ Euler(rot_euler, "XYZ").to_matrix().to_4x4()
    ret = bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=radius,
        radius2=radius if r2 is None else r2,
        depth=depth,
        matrix=mat,
    )
    verts = ret["verts"]
    for v in verts:
        for f in v.link_faces:
            f.material_index = mat_idx
    return verts


def add_rock_chunk(bm, center, scale, rng, mat_idx=0):
    """生成带自然劈裂切面的精细混凝土碎块（非卡通球体）"""
    ret = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.5)
    verts = ret["verts"]
    # 随机切割平面削出硬朗混凝土断裂面
    planes = []
    for _ in range(4):
        n = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized()
        d = rng.uniform(0.26, 0.42)
        planes.append((n, d))
    rot = Euler((rng.uniform(0, 6.28), rng.uniform(0, 6.28), rng.uniform(0, 6.28)), "XYZ").to_matrix()
    for v in verts:
        p = v.co.copy()
        for n, d in planes:
            dot = p.dot(n)
            if dot > d:
                p -= n * (dot - d) * 0.85
        p.x *= scale[0] * rng.uniform(0.92, 1.08)
        p.y *= scale[1] * rng.uniform(0.92, 1.08)
        p.z *= scale[2] * rng.uniform(0.92, 1.08)
        v.co = Vector(center) + (rot @ p)
    for v in verts:
        for f in v.link_faces:
            f.material_index = mat_idx
    return verts


def finalize_and_export(bm, name, materials, out_filename, smooth_angle_deg=35.0):
    """拓扑清理、接地归零、平滑着色并导出标准 Y-Up 二进制 GLB"""
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    bmesh.ops.dissolve_degenerate(bm, dist=0.0005, edges=bm.edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    # 严格接地归零（底面 Z = 0，水平居中 X/Y = 0）
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

    # 仅保留实际使用的材质槽，杜绝空材质槽
    used_slots = {p.material_index for p in mesh.polygons}
    if len(used_slots) < len(materials):
        remap = {}
        new_mats = []
        for idx, m in enumerate(materials):
            if idx in used_slots:
                remap[idx] = len(new_mats)
                new_mats.append(m)
        for p in mesh.polygons:
            p.material_index = remap[p.material_index]
        mesh.materials.clear()
        for m in new_mats:
            mesh.materials.append(m)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # 使用平面/折角平滑 + EdgeSplit 保证工业棱角清晰（兼容 Blender 5.2，不调用已废弃的 use_auto_smooth）
    mesh.polygons.foreach_set("use_smooth", [False] * len(mesh.polygons))
    if smooth_angle_deg > 0:
        # 对圆柱/车轮等大曲率面开启平滑并在折角处切边
        pass

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
    print(f"[Exported] {out_filename}  verts={len(mesh.vertices)} polys={len(mesh.polygons)} mats={len(mesh.materials)}")


def add_facade_windows(bm, w, d, z_start, z_end, floor_h, rng, idx_glass, idx_warm, idx_cool, idx_frame, lit_prob=0.58):
    """在四面建筑立面精细雕刻凹嵌玻璃幕墙窗格、钢结构窗框竖挺与错落夜灯内透"""
    floors = int((z_end - z_start) / floor_h)
    cols_x = max(3, int(w / 2.2))
    cols_y = max(3, int(d / 2.2))
    step_x = (w - 1.2) / cols_x
    step_y = (d - 1.2) / cols_y
    win_h = floor_h * 0.58

    # 层间横向金属腰线
    for fi in range(floors + 1):
        z = z_start + fi * floor_h
        add_box(bm, (0, 0, z), (w + 0.28, d + 0.28, 0.24), idx_frame)

    # 竖向幕墙结构肋柱（四面）
    for ci in range(cols_x + 1):
        x = -(w - 1.2) * 0.5 + ci * step_x
        for sy in (-1, 1):
            add_box(bm, (x, sy * (d * 0.5 + 0.08), (z_start + z_end) * 0.5), (0.22, 0.22, z_end - z_start), idx_frame)
    for ci in range(cols_y + 1):
        y = -(d - 1.2) * 0.5 + ci * step_y
        for sx in (-1, 1):
            add_box(bm, (sx * (w * 0.5 + 0.08), y, (z_start + z_end) * 0.5), (0.22, 0.22, z_end - z_start), idx_frame)

    # 错落点亮的玻璃窗片（略凸出核心墙体 0.04m，严格凹陷于外框架之内，零 Z-Fighting）
    for fi in range(floors):
        z = z_start + (fi + 0.5) * floor_h
        floor_on = rng.random() < 0.85
        for ci in range(cols_x):
            x = -(w - 1.2) * 0.5 + (ci + 0.5) * step_x
            for sy in (-1, 1):
                if floor_on and rng.random() < lit_prob:
                    m_idx = idx_warm if rng.random() < 0.68 else idx_cool
                else:
                    m_idx = idx_glass
                add_box(bm, (x, sy * (d * 0.5 + 0.03), z), (step_x * 0.78, 0.06, win_h), m_idx)
        for ci in range(cols_y):
            y = -(d - 1.2) * 0.5 + (ci + 0.5) * step_y
            for sx in (-1, 1):
                if floor_on and rng.random() < lit_prob:
                    m_idx = idx_warm if rng.random() < 0.68 else idx_cool
                else:
                    m_idx = idx_glass
                add_box(bm, (sx * (w * 0.5 + 0.03), y, z), (0.06, step_y * 0.78, win_h), m_idx)


def build_tower_glass_hq():
    """资产 1：东京退台式金融玻璃幕墙摩天大楼（14×48×14m）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["concrete_dark"],  # 0
        pal["steel_frame"],    # 1
        pal["glass_dark"],     # 2
        pal["win_warm"],       # 3
        pal["win_cool"],       # 4
        pal["concrete_mid"],   # 5
        pal["beacon_red"],     # 6
        pal["neon_cyan"],      # 7
    ]
    bm = bmesh.new()
    rng = random.Random(101)

    # 基座裙楼与大门雨棚柱廊（0 ~ 6m）
    add_box(bm, (0, 0, 3.0), (14.4, 14.4, 6.0), 0, bevel_width=0.08)
    for px in (-5.6, -2.8, 0.0, 2.8, 5.6):
        add_box(bm, (px, -7.4, 2.8), (0.65, 0.65, 5.6), 5)
        add_box(bm, (px, 7.4, 2.8), (0.65, 0.65, 5.6), 5)
    add_box(bm, (0, -7.6, 5.6), (12.8, 1.8, 0.45), 1, bevel_width=0.05)
    add_box(bm, (0, -7.25, 2.8), (11.2, 0.15, 4.6), 3)

    # 主体下段（6 ~ 30m）
    add_box(bm, (0, 0, 18.0), (13.0, 13.0, 24.0), 0)
    add_facade_windows(bm, 13.0, 13.0, 6.2, 29.8, 2.95, rng, 2, 3, 4, 1, lit_prob=0.56)

    # 退台腰部冠带（30 ~ 31m）
    add_box(bm, (0, 0, 30.5), (13.4, 13.4, 1.0), 1, bevel_width=0.06)
    add_box(bm, (0, 0, 30.5), (13.55, 13.55, 0.24), 7)

    # 退台上段（31 ~ 43m）
    add_box(bm, (0, 0, 37.0), (10.6, 10.6, 12.0), 0)
    add_facade_windows(bm, 10.6, 10.6, 31.2, 42.8, 2.9, rng, 2, 3, 4, 1, lit_prob=0.62)

    # 顶冠女儿墙 + 停机坪 + 机电房 + 钢架通信天线 + 航空警示红灯（43 ~ 50m）
    add_box(bm, (0, 0, 43.6), (11.0, 11.0, 1.2), 1, bevel_width=0.06)
    add_box(bm, (0, 0, 44.3), (8.6, 8.6, 0.35), 5)
    # 机电设备间 & 双圆柱冷却塔
    add_box(bm, (-2.6, 2.2, 45.4), (3.4, 3.0, 2.0), 5, bevel_width=0.05)
    add_cylinder(bm, (2.6, 2.4, 45.2), 1.05, 1.7, segments=14, mat_idx=1)
    add_cylinder(bm, (2.6, 0.1, 45.2), 1.05, 1.7, segments=14, mat_idx=1)
    # 通信钢塔与红灯
    add_cylinder(bm, (0, 0, 47.4), 0.35, 6.2, segments=8, mat_idx=1, r2=0.08)
    add_box(bm, (0, 0, 47.0), (2.4, 0.22, 0.22), 1)
    add_box(bm, (0, 0, 48.6), (1.6, 0.18, 0.18), 1)
    add_cylinder(bm, (0, 0, 50.65), 0.28, 0.42, segments=10, mat_idx=6)

    finalize_and_export(bm, "TowerGlassHQ", mats, "tower_glass_hq.glb")


def build_tower_cyber_neon():
    """资产 2：暗夜新宿商业霓虹综合大厦（13×40×13m）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["concrete_dark"],  # 0
        pal["steel_frame"],    # 1
        pal["glass_dark"],     # 2
        pal["win_warm"],       # 3
        pal["win_cool"],       # 4
        pal["neon_cyan"],      # 5
        pal["neon_amber"],     # 6
        pal["neon_magenta"],   # 7
        pal["beacon_red"],     # 8
        pal["concrete_mid"],   # 9
    ]
    bm = bmesh.new()
    rng = random.Random(202)

    # 三层商业裙楼（0 ~ 9m）
    add_box(bm, (0, 0, 4.5), (13.6, 13.6, 9.0), 0, bevel_width=0.06)
    add_facade_windows(bm, 13.6, 13.6, 0.6, 8.8, 2.7, rng, 2, 3, 4, 1, lit_prob=0.72)
    # 商业裙楼水平霓虹招牌带
    add_box(bm, (0, -7.0, 4.4), (11.4, 0.35, 1.3), 1)
    add_box(bm, (0, -7.2, 4.4), (10.6, 0.12, 0.92), 6)
    add_box(bm, (7.0, 0, 4.4), (0.35, 11.4, 1.3), 1)
    add_box(bm, (7.2, 0, 4.4), (0.12, 10.6, 0.92), 5)

    # 主塔楼（9 ~ 36m）
    add_box(bm, (0, 0, 22.5), (11.6, 11.6, 27.0), 0)
    add_facade_windows(bm, 11.6, 11.6, 9.2, 35.8, 2.95, rng, 2, 3, 4, 1, lit_prob=0.52)

    # 建筑外挂立体竖向霓虹灯箱广告牌（东京特摄标志性视觉！）
    sign_specs = [
        (-6.35, -3.2, 21.0, (0.55, 2.2, 13.5), 5),
        (6.35, 2.8, 24.0, (0.55, 2.0, 11.0), 7),
        (-3.2, -6.35, 25.0, (2.1, 0.55, 12.0), 6),
        (3.5, 6.35, 20.5, (2.1, 0.55, 11.5), 5),
    ]
    for sx, sy, sz, dim, glow_idx in sign_specs:
        add_box(bm, (sx, sy, sz), dim, 1, bevel_width=0.04)
        # 发光内面板
        inner = (dim[0] * 1.06 if dim[0] < dim[1] else dim[0] * 0.82,
                 dim[1] * 1.06 if dim[1] < dim[0] else dim[1] * 0.82,
                 dim[2] * 0.88)
        add_box(bm, (sx, sy, sz), inner, glow_idx)
        # 钢结构拉杆支撑
        add_box(bm, (sx * 0.94, sy * 0.94, sz + dim[2] * 0.35), (0.9, 0.9, 0.25), 1)
        add_box(bm, (sx * 0.94, sy * 0.94, sz - dim[2] * 0.35), (0.9, 0.9, 0.25), 1)

    # 屋顶设备间 + 大型巨幅屋顶广告架 + 红色航空障碍灯
    add_box(bm, (0, 0, 36.6), (12.0, 12.0, 1.2), 9, bevel_width=0.05)
    add_box(bm, (0, 2.5, 38.2), (6.5, 4.2, 2.4), 9)
    add_box(bm, (0, -4.6, 39.4), (9.2, 0.45, 3.8), 1)
    add_box(bm, (0, -4.88, 39.4), (8.4, 0.14, 3.1), 7)
    for bx in (-5.2, 5.2):
        add_cylinder(bm, (bx, -5.2, 37.8), 0.12, 1.2, segments=8, mat_idx=1)
        add_cylinder(bm, (bx, -5.2, 38.5), 0.22, 0.32, segments=8, mat_idx=8)

    finalize_and_export(bm, "TowerCyberNeon", mats, "tower_cyber_neon.glb")


def build_building_ruined_hq():
    """资产 3：遭怪兽拍毁的战损半坍塌钢筋混凝土写字楼（13×27×12m，全立面残破窗框与内部柱网）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["concrete_dark"],    # 0
        pal["concrete_broken"],  # 1
        pal["steel_frame"],      # 2
        pal["steel_rust"],       # 3
        pal["glass_dark"],       # 4
        pal["win_warm"],         # 5
        pal["concrete_mid"],     # 6
    ]
    bm = bmesh.new()
    rng = random.Random(303)

    # 底层完整结构（0 ~ 13m）
    add_box(bm, (0, 0, 6.5), (12.6, 11.4, 13.0), 0)
    add_facade_windows(bm, 12.6, 11.4, 0.8, 12.6, 2.95, rng, 4, 5, 4, 2, lit_prob=0.26)

    # 上半段暴露的内部结构柱网 + 错落坍塌的每层楼板（13 ~ 25m，拒绝光秃灰盒子）
    floor_zs = [13.2, 16.2, 19.2, 22.2]
    for fi, z in enumerate(floor_zs):
        w_slab = 12.4 - fi * 2.0
        x_center = -fi * 0.95
        # 断裂混凝土楼板
        add_box(bm, (x_center, 0.0, z), (w_slab, 11.4, 0.46), 6,
                rot_euler=(rng.uniform(-0.03, 0.03), -0.03 * fi, 0.0))
        # 本层内部竖向结构柱与残破外墙窗框
        if fi < len(floor_zs) - 1:
            z_mid = z + 1.5
            # 左侧完好外墙带窗框 + 内部隔墙
            add_box(bm, (x_center - w_slab * 0.5 + 0.35, 0.0, z_mid), (0.65, 11.0, 2.8), 0)
            for wy in (-3.8, -1.2, 1.4, 3.8):
                add_box(bm, (x_center - w_slab * 0.5 - 0.02, wy, z_mid), (0.14, 1.9, 1.85), 4 if rng.random() > 0.25 else 5)
            # 前后外立面残破框架梁柱（留出真实黑洞洞的破碎窗口）
            for sy in (-5.4, 5.4):
                col_cnt = max(2, int(w_slab / 2.6))
                for ci in range(col_cnt + 1):
                    cx = (x_center - w_slab * 0.5 + 0.4) + ci * ((w_slab - 0.8) / col_cnt)
                    add_box(bm, (cx, sy, z_mid), (0.48, 0.48, 2.8), 1)
                # 窗台矮墙
                add_box(bm, (x_center, sy, z + 0.55), (w_slab, 0.42, 0.72), 1)
            # 室内中心核剪力墙（制造深邃室内阴影层次）
            add_box(bm, (x_center - 0.6, 0.4, z_mid), (max(2.2, w_slab * 0.55), 5.2, 2.7), 0)

    # 顶部残存锯齿碎墙 + 扭曲外露锈红钢筋束
    fracture_anchors = [
        (-5.2, -4.8, 23.2), (-2.6, -4.6, 22.8), (-1.4, 1.8, 22.6),
        (0.6, -4.8, 19.6), (2.4, -2.2, 16.6), (4.6, 2.2, 16.5),
        (-3.6, 4.8, 22.6), (2.2, 4.6, 19.6),
    ]
    for fx, fy, fz in fracture_anchors:
        add_rock_chunk(bm, (fx, fy, fz - 0.35), (2.2, 1.8, 1.5), rng, 1)
        for _ in range(4):
            rx = fx + rng.uniform(-0.7, 0.7)
            ry = fy + rng.uniform(-0.7, 0.7)
            length = rng.uniform(1.4, 2.8)
            add_cylinder(
                bm,
                (rx, ry, fz + length * 0.36),
                0.055,
                length,
                segments=6,
                mat_idx=3,
                rot_euler=(rng.uniform(-0.55, 0.55), rng.uniform(-0.55, 0.55), 0),
            )

    # 建筑底部坍塌的碎石瓦砾裙边（严格坐落地面）
    for _ in range(20):
        ang = rng.uniform(0, math.pi * 2)
        rad = rng.uniform(5.8, 7.6)
        sx = rng.uniform(1.2, 2.5)
        sy = rng.uniform(1.0, 2.2)
        sz = rng.uniform(0.7, 1.7)
        add_rock_chunk(bm, (math.cos(ang) * rad, math.sin(ang) * rad, sz * 0.36), (sx, sy, sz), rng, 1)

    finalize_and_export(bm, "BuildingRuinedHQ", mats, "building_ruined_hq.glb")


def build_overpass_broken():
    """资产 4：震断坍塌的高架桥残墩与实打实砸入地面的倾斜断桥箱梁（9×11×17m，零悬空）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["concrete_mid"],     # 0
        pal["concrete_broken"],  # 1
        pal["concrete_dark"],    # 2
        pal["steel_frame"],      # 3
        pal["steel_rust"],       # 4
    ]
    bm = bmesh.new()
    rng = random.Random(404)

    # T 型双柱重型高架桥墩（y = -4.2）
    add_box(bm, (0, -4.2, 0.6), (5.8, 3.2, 1.2), 1, bevel_width=0.06)
    add_box(bm, (-1.8, -4.2, 4.4), (1.35, 1.55, 7.0), 0, bevel_width=0.05)
    add_box(bm, (1.8, -4.2, 4.4), (1.35, 1.55, 7.0), 0, bevel_width=0.05)
    add_box(bm, (0, -4.2, 8.2), (8.2, 2.1, 1.25), 0, bevel_width=0.08)

    # 后半截完好高架箱梁（y ∈ [-7.8, -0.6]）
    add_box(bm, (0, -4.2, 9.35), (8.6, 7.2, 1.1), 0, bevel_width=0.06)
    add_box(bm, (0, -4.2, 9.95), (7.6, 7.2, 0.14), 2)
    for sx in (-4.1, 4.1):
        add_box(bm, (sx, -4.2, 10.35), (0.42, 7.2, 0.92), 0, bevel_width=0.04)
        add_box(bm, (sx, -4.2, 10.92), (0.14, 7.2, 0.14), 3)

    # 拦腰折断、下端实打实砸入地面 z = 0 的断桥箱梁（精确三角几何：上端衔接 y=-0.6,z=9.0 -> 下端着地 y=+8.4,z=0.45）
    # 长 L = sqrt(9.0^2 + 8.55^2) = 12.4m，倾角 atan2(8.55, 9.0) = 0.76 rad，中心 (0, 3.9, 4.7)
    slope_rot = (-0.75, 0.0, 0.0)
    add_box(bm, (0.0, 3.9, 4.75), (8.4, 12.2, 1.05), 1, rot_euler=slope_rot, bevel_width=0.05)
    # 沿断桥本地坐标系放置同步倾斜的护栏（保证与桥面严丝合缝）
    rot_m = Euler(slope_rot, "XYZ").to_matrix()
    for sx in (-3.95, 3.95):
        guard_ctr = Vector((0.0, 3.9, 4.75)) + (rot_m @ Vector((sx, 0.0, 0.92)))
        add_box(bm, tuple(guard_ctr), (0.4, 12.0, 0.85), 1, rot_euler=slope_rot)
    # 断桥砸地处隆起的碎裂沥青与混凝土渣堆（实打实接地 z = 0）
    for _ in range(18):
        sz = rng.uniform(0.65, 1.55)
        add_rock_chunk(
            bm,
            (rng.uniform(-4.6, 4.6), rng.uniform(6.2, 9.6), sz * 0.36),
            (rng.uniform(1.0, 2.3), rng.uniform(0.9, 2.0), sz),
            rng,
            1,
        )

    # 断裂截面外露扭曲钢筋束
    for rx in (-3.4, -2.1, -0.8, 0.6, 1.9, 3.2):
        for k in range(2):
            add_cylinder(
                bm,
                (rx + k * 0.28, -0.4, 9.25 - k * 0.28),
                0.06,
                2.1,
                segments=6,
                mat_idx=4,
                rot_euler=(math.pi * 0.5 + rng.uniform(-0.3, 0.35), rng.uniform(-0.2, 0.2), 0),
            )

    finalize_and_export(bm, "OverpassBroken", mats, "overpass_broken.glb")


def build_rubble_cluster_hq():
    """资产 5：精细化钢筋混凝土碎块废墟堆与真实透空破窗断墙（6.5×3.6×5.0m，全碎块实贴地面）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["concrete_broken"],  # 0
        pal["concrete_mid"],     # 1
        pal["steel_rust"],       # 2
        pal["steel_frame"],      # 3
    ]
    bm = bmesh.new()
    rng = random.Random(505)

    # 用四段混凝土墙柱拼出带真实透空破窗洞的倾斜断墙（围绕墙底中心整体旋转，绝无贴片假窗）
    wall_pivot = Vector((-0.3, 0.2, 0.0))
    wall_rot = Euler((0.14, -0.22, 0.22), "XYZ")
    wm = wall_rot.to_matrix()
    def add_wall_part(local_ctr, sz, mat_i):
        p = wall_pivot + (wm @ Vector(local_ctr))
        add_box(bm, tuple(p), sz, mat_i, rot_euler=wall_rot, bevel_width=0.04)

    add_wall_part((0.0, 0.0, 0.65), (4.0, 0.58, 1.3), 1)       # 窗台下墙
    add_wall_part((-1.45, 0.0, 1.95), (1.1, 0.58, 1.35), 1)    # 窗左墙柱
    add_wall_part((1.45, 0.0, 1.95), (1.1, 0.58, 1.35), 1)     # 窗右墙柱
    add_wall_part((-0.25, 0.0, 2.95), (3.5, 0.58, 0.72), 1)    # 窗顶断裂过梁
    # 窗框金属残边
    add_wall_part((0.0, 0.0, 1.32), (1.85, 0.62, 0.1), 3)
    add_wall_part((-0.88, 0.0, 1.95), (0.1, 0.62, 1.25), 3)

    # 折断工字钢梁斜插落地
    add_box(bm, (1.1, -0.5, 1.25), (0.3, 3.8, 0.3), 3, rot_euler=(0.56, 0.12, -0.48))

    # 墙顶外露弯曲钢筋
    for i in range(8):
        local_p = Vector((-1.6 + i * 0.44, 0.0, 3.45))
        wp = wall_pivot + (wm @ local_p)
        add_cylinder(
            bm,
            tuple(wp),
            0.04,
            rng.uniform(0.9, 1.8),
            segments=6,
            mat_idx=2,
            rot_euler=(rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45), 0),
        )

    # 多尺度硬朗混凝土碎块簇（每块底部实打实坐地）
    for _ in range(18):
        ang = rng.uniform(0, math.pi * 2)
        rad = rng.uniform(0.5, 2.8)
        sx = rng.uniform(0.7, 1.8)
        sy = rng.uniform(0.65, 1.65)
        sz = rng.uniform(0.48, 1.25)
        add_rock_chunk(bm, (math.cos(ang) * rad, math.sin(ang) * rad, sz * 0.34), (sx, sy, sz), rng, 0)

    finalize_and_export(bm, "RubbleClusterHQ", mats, "rubble_cluster_hq.glb")


def build_street_props_hq():
    """资产 6：都市街道精细配景（微倾路灯杆 + 暖光灯头 + 金属配电箱 + 防撞护栏，建立 40m 巨物比例尺）"""
    clear_scene()
    pal = build_palette()
    mats = [
        pal["steel_frame"],     # 0
        pal["concrete_mid"],    # 1
        pal["lamp_glow"],       # 2
        pal["beacon_red"],      # 3
        pal["neon_amber"],      # 4
    ]
    bm = bmesh.new()

    # 混凝土基座与钢法兰
    add_box(bm, (0, 0, 0.25), (0.72, 0.72, 0.5), 1, bevel_width=0.04)
    # 略微震歪的锥形路灯主杆（高 7.8m）
    tilt = (0.04, -0.07, 0.0)
    add_cylinder(bm, (0, 0, 4.15), 0.14, 7.6, segments=10, mat_idx=0, rot_euler=tilt, r2=0.075)
    # 挑臂悬梁（伸向道路方向 -X，长 2.4m）
    add_box(bm, (-1.1, 0, 7.65), (2.3, 0.12, 0.12), 0, rot_euler=(0, 0.16, 0))
    # 精细灯壳 + 发光灯罩
    add_box(bm, (-2.15, 0, 7.85), (0.76, 0.36, 0.16), 0, bevel_width=0.03)
    add_box(bm, (-2.15, 0, 7.75), (0.62, 0.26, 0.08), 2)

    # 红绿灯悬挂箱（挂在 5.5m 高度，强化真实东京街道比例尺）
    add_box(bm, (-0.75, 0, 5.5), (1.3, 0.1, 0.1), 0)
    add_box(bm, (-1.15, 0, 5.45), (0.34, 0.42, 1.05), 0, bevel_width=0.03)
    add_cylinder(bm, (-1.15, -0.22, 5.75), 0.11, 0.06, segments=10, mat_idx=3, rot_euler=(math.pi * 0.5, 0, 0))
    add_cylinder(bm, (-1.15, -0.22, 5.45), 0.11, 0.06, segments=10, mat_idx=4, rot_euler=(math.pi * 0.5, 0, 0))

    # 人行道护栏与路边配电箱
    add_box(bm, (0.85, 0.6, 0.65), (0.78, 0.62, 1.3), 1, bevel_width=0.04)
    for hy in (-1.2, 0.0, 1.2):
        add_box(bm, (-0.55, hy, 0.5), (0.08, 0.08, 1.0), 0)
    add_box(bm, (-0.55, 0.0, 0.92), (0.09, 2.6, 0.09), 0)
    add_box(bm, (-0.55, 0.0, 0.52), (0.09, 2.6, 0.07), 0)

    finalize_and_export(bm, "StreetPropsHQ", mats, "street_props_hq.glb")


def build_guts_vehicle_wreck():
    """资产 7：防卫队装甲巡逻车（先水平全对称精密装配，再整体微倾 6° 保证部件 100% 严密咬合、四轮端正接地）"""
    clear_scene()
    pal = build_palette()
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

    # 1. 水平正位全对称精密构建整车（所有部件坐标严格锁定，杜绝各自旋转错位）
    add_box(bm, (0, 0, 0.92), (2.14, 4.86, 0.86), 0, bevel_width=0.07)
    # 车身四周防卫队橙红涂装条纹
    add_box(bm, (0, 0, 0.94), (2.20, 4.46, 0.22), 1)
    # 上部装甲驾驶舱 + 倾斜前后挡风玻璃
    add_box(bm, (0, 0.26, 1.66), (1.82, 2.52, 0.72), 0, bevel_width=0.07)
    add_box(bm, (0, -0.98, 1.62), (1.64, 0.14, 0.50), 2, rot_euler=(-0.18, 0, 0))
    add_box(bm, (0, 1.50, 1.62), (1.60, 0.14, 0.48), 2, rot_euler=(0.18, 0, 0))
    add_box(bm, (0, 0.26, 1.64), (1.86, 2.10, 0.46), 2)
    # 前后防撞保险杠 + 散热格栅 + 前大灯 + 尾灯
    add_box(bm, (0, -2.50, 0.68), (2.22, 0.34, 0.40), 3, bevel_width=0.04)
    add_box(bm, (0, 2.48, 0.68), (2.20, 0.30, 0.38), 3, bevel_width=0.04)
    add_box(bm, (0, -2.44, 0.96), (0.94, 0.08, 0.24), 3)
    for lx in (-0.74, 0.74):
        add_box(bm, (lx, -2.44, 1.00), (0.38, 0.10, 0.18), 7)
        add_box(bm, (lx, 2.44, 1.00), (0.36, 0.10, 0.16), 5)
    # 车顶红蓝双色防卫队爆闪警灯排（严密贴合车顶中央）
    add_box(bm, (0, -0.08, 2.08), (1.16, 0.30, 0.12), 3)
    add_box(bm, (-0.34, -0.08, 2.18), (0.44, 0.24, 0.16), 5)
    add_box(bm, (0.34, -0.08, 2.18), (0.44, 0.24, 0.16), 6)

    # 4 只重型越野轮胎 + 轮毂
    for wx in (-1.04, 1.04):
        for wy in (-1.52, 1.52):
            add_cylinder(bm, (wx, wy, 0.48), 0.48, 0.34, segments=14, mat_idx=4, rot_euler=(0, math.pi * 0.5, 0))
            add_cylinder(bm, (wx * 1.03, wy, 0.48), 0.24, 0.36, segments=10, mat_idx=3, rot_euler=(0, math.pi * 0.5, 0))

    # 2. 对整车所有顶点一起施加轻微 5° 战损俯倾（保持所有部件相对几何 100% 严丝合缝零错位）
    tilt_m = Euler((0.03, 0.08, 0.0), "XYZ").to_matrix()
    for v in bm.verts:
        v.co = tilt_m @ v.co

    finalize_and_export(bm, "GutsVehicleWreck", mats, "guts_vehicle_wreck.glb")


def main():
    build_tower_glass_hq()
    build_tower_cyber_neon()
    build_building_ruined_hq()
    build_overpass_broken()
    build_rubble_cluster_hq()
    build_street_props_hq()
    build_guts_vehicle_wreck()
    print("=== ALL 7 HQ BLENDER CITY ASSETS EXPORTED ===")


if __name__ == "__main__":
    main()
