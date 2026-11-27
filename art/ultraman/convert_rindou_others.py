"""
Blender 5.2 无头脚本：将リンドウ式赛罗、戴拿、泽塔 PMX 模型批量转换为游戏标准高保真 GLB

输出资产：
- ui/public/models/ultraman/zero.glb  （リンドウ式ゼロ2.0）
- ui/public/models/ultraman/dyna.glb  （リンドウ式ダイナ2.1 闪亮型，兼容三形态实时换色）
- ui/public/models/ultraman/zeta.glb  （リンドウ式ゼットオリジナル 泽塔原生形态）

统一特性：
1. 原生解析 PMX 2.0 顶点、自定义锐边/光滑法线、UV、材质分区与精准蒙皮权重，并校验外法线一致性
2. 全部映射至游戏统一 51 骨 `ultraBones` 骨架（含双锁骨、30 根 3 节指骨、双脚尖与 `bone_tips`）
3. 剔除 MMD 专用隐藏叠加层与灰雾覆盖层，保留原版贴图全部细节并校色重制全通道 PBR + 独立发光复眼与计时器
"""
import os
import struct
import tempfile
import unicodedata
import bpy
import numpy as np
from mathutils import Vector

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
ASSETS_ROOT = os.environ.get("RINDOU_ASSETS_ROOT", os.path.join(REPO_ROOT, "资源/奥特曼建模"))
OUT_DIR = os.path.join(REPO_ROOT, "ui/public/models/ultraman")

# 通用 MMD 骨骼 -> 游戏标准 ultraBones 骨名映射（覆盖全部 4 位リンドウ式模型）
PMX_TO_STD_BONE = {
    "下半身": "hip",
    "上半身": "spineLower",
    "上半身2": "spineChest",
    "上半身2先": "spineChest",
    "首": "neckUpper",
    "頭": "head",
    # 赛罗头镖随头部运动
    "スラッガー左": "head",
    "スラッガー右": "head",
    "左胸スラッガー": "spineChest",
    "右胸スラッガー": "spineChest",
    # 双臂及 MMD 扭转辅助骨（腕捩归大臂，手捩含手镯归前臂）
    "左肩": "Collar_L",
    "左腕": "UpperArm_L",
    "左腕捩": "UpperArm_L",
    "左腕捩1": "UpperArm_L",
    "左腕捩2": "UpperArm_L",
    "左腕捩3": "UpperArm_L",
    "左ひじ": "LowerArm_L",
    "左手捩": "LowerArm_L",
    "左手捩1": "LowerArm_L",
    "左手捩2": "LowerArm_L",
    "左手捩3": "LowerArm_L",
    "左手首": "Hand_L",
    "右肩": "Collar_R",
    "右腕": "UpperArm_R",
    "右腕捩": "UpperArm_R",
    "右腕捩1": "UpperArm_R",
    "右腕捩2": "UpperArm_R",
    "右腕捩3": "UpperArm_R",
    "右ひじ": "LowerArm_R",
    "右手捩": "LowerArm_R",
    "右手捩1": "LowerArm_R",
    "右手捩2": "LowerArm_R",
    "右手捩3": "LowerArm_R",
    "右手首": "Hand_R",
    # 双腿
    "左足": "Thigh_L",
    "左ひざ": "Shin_L",
    "左足首": "Foot_L",
    "左足先EX": "Toe_L",
    "右足": "Thigh_R",
    "右ひざ": "Shin_R",
    "右足首": "Foot_R",
    "右足先EX": "Toe_R",
    # 30 根 3 节指骨
    "左親指0": "Thumb1_L", "左親指１": "Thumb2_L", "左親指２": "Thumb3_L",
    "左人指１": "Index1_L", "左人指２": "Index2_L", "左人指３": "Index3_L",
    "左中指１": "Mid1_L",   "左中指２": "Mid2_L",   "左中指３": "Mid3_L",
    "左薬指１": "Ring1_L",  "左薬指２": "Ring2_L",  "左薬指３": "Ring3_L",
    "左小指１": "Pinky1_L", "左小指２": "Pinky2_L", "左小指３": "Pinky3_L",
    "右親指0": "Thumb1_R", "右親指１": "Thumb2_R", "右親指２": "Thumb3_R",
    "右人指１": "Index1_R", "右人指２": "Index2_R", "右人指３": "Index3_R",
    "右中指１": "Mid1_R",   "右中指２": "Mid2_R",   "右中指３": "Mid3_R",
    "右薬指１": "Ring1_R",  "右薬指２": "Ring2_R",  "右薬指３": "Ring3_R",
    "右小指１": "Pinky1_R", "右小指２": "Pinky2_R", "右小指３": "Pinky3_R",
}


def resolve_nfc_path(root: str, rel: str) -> str:
    """兼容 macOS NFD 文件名规范化解析路径"""
    cur = root
    for part in rel.split("/"):
        target = unicodedata.normalize("NFC", part)
        direct = os.path.join(cur, part)
        if os.path.exists(direct):
            cur = direct
            continue
        found = None
        for item in os.listdir(cur):
            if unicodedata.normalize("NFC", item) == target:
                found = os.path.join(cur, item)
                break
        if found is None:
            raise FileNotFoundError(f"找不到路径节点 {part!r} (位于 {cur})")
        cur = found
    return cur


def parse_pmx(path: str):
    """完整解析 PMX 2.0 顶点、法线、UV、蒙皮权重、三角形、材质与骨骼"""
    with open(path, "rb") as f:
        sig = f.read(4)
        if sig != b"PMX ":
            raise ValueError(f"非法 PMX 文件头: {sig!r}")
        _ver = struct.unpack("<f", f.read(4))[0]
        g_cnt = struct.unpack("<B", f.read(1))[0]
        g = list(f.read(g_cnt))
        enc = "utf-16-le" if g[0] == 0 else "utf-8"
        add_uv, v_sz, t_sz, m_sz, b_sz = g[1:6]

        def read_text() -> str:
            n = struct.unpack("<i", f.read(4))[0]
            return f.read(n).decode(enc, errors="replace")

        def read_idx(sz: int, unsigned: bool = False) -> int:
            if sz == 1:
                return struct.unpack("<B" if unsigned else "<b", f.read(1))[0]
            if sz == 2:
                return struct.unpack("<H" if unsigned else "<h", f.read(2))[0]
            return struct.unpack("<i", f.read(4))[0]

        read_text(); read_text(); read_text(); read_text()
        v_cnt = struct.unpack("<i", f.read(4))[0]
        verts, normals, uvs, weights = [], [], [], []
        for _ in range(v_cnt):
            x, y, z, nx, ny, nz, u, v = struct.unpack("<8f", f.read(32))
            if add_uv > 0:
                f.read(16 * add_uv)
            wt = struct.unpack("<B", f.read(1))[0]
            w_list = []
            if wt == 0:
                b0 = read_idx(b_sz)
                if b0 >= 0:
                    w_list.append((b0, 1.0))
            elif wt == 1:
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            elif wt in (2, 4):
                bs = [read_idx(b_sz) for _ in range(4)]
                ws = struct.unpack("<4f", f.read(16))
                for b, w in zip(bs, ws):
                    if b >= 0 and w > 1e-6:
                        w_list.append((b, w))
            elif wt == 3:
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                f.read(36)
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            f.read(4)
            verts.append((x, y, z))
            normals.append((nx, ny, nz))
            uvs.append((u, v))
            weights.append(w_list)

        i_cnt = struct.unpack("<i", f.read(4))[0]
        indices = [read_idx(v_sz, unsigned=True) for _ in range(i_cnt)]
        tex_cnt = struct.unpack("<i", f.read(4))[0]
        textures = [read_text() for _ in range(tex_cnt)]

        mat_cnt = struct.unpack("<i", f.read(4))[0]
        materials = []
        cursor = 0
        for _ in range(mat_cnt):
            mn = read_text(); read_text()
            diff = struct.unpack("<4f", f.read(16))
            f.read(12 + 4 + 12 + 1 + 20)
            tex_i = read_idx(t_sz); read_idx(t_sz); f.read(1)
            tf = struct.unpack("<B", f.read(1))[0]
            if tf == 1:
                f.read(1)
            else:
                read_idx(t_sz)
            read_text()
            fcnt = struct.unpack("<i", f.read(4))[0]
            materials.append({
                "name": mn,
                "diffuse": diff,
                "texture": textures[tex_i] if 0 <= tex_i < len(textures) else None,
                "index_start": cursor,
                "index_count": fcnt,
            })
            cursor += fcnt

        bone_cnt = struct.unpack("<i", f.read(4))[0]
        bones = []
        for idx in range(bone_cnt):
            bn = read_text(); read_text()
            pos = struct.unpack("<3f", f.read(12))
            parent = read_idx(b_sz); f.read(4)
            flag = struct.unpack("<H", f.read(2))[0]
            if flag & 0x0001:
                read_idx(b_sz)
            else:
                f.read(12)
            if (flag & 0x0100) or (flag & 0x0200):
                read_idx(b_sz); f.read(4)
            if flag & 0x0400:
                f.read(12)
            if flag & 0x0800:
                f.read(24)
            if flag & 0x2000:
                f.read(4)
            if flag & 0x0020:
                read_idx(b_sz); f.read(8)
                lcnt = struct.unpack("<i", f.read(4))[0]
                for _ in range(lcnt):
                    read_idx(b_sz)
                    if struct.unpack("<B", f.read(1))[0]:
                        f.read(24)
            bones.append({"idx": idx, "name": bn, "pos": pos, "parent": parent})

    return {
        "verts": verts,
        "normals": normals,
        "uvs": uvs,
        "weights": weights,
        "indices": indices,
        "materials": materials,
        "bones": bones,
    }


# ---------- 纯 numpy 图像处理工具 ----------

def load_rgba_array(pmx_dir: str, filename: str) -> np.ndarray:
    path = resolve_nfc_path(pmx_dir, filename)
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    arr = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return arr


def make_blender_image(name: str, rgba: np.ndarray, tmp_dir: str, colorspace: str = "sRGB") -> bpy.types.Image:
    h, w, _ = rgba.shape
    tmp_img = bpy.data.images.new(name=f"_tmp_{name}", width=w, height=h, alpha=True, float_buffer=False)
    tmp_img.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).astype(np.float32).ravel())
    out_path = os.path.join(tmp_dir, f"{name}.png")
    tmp_img.filepath_raw = out_path
    tmp_img.file_format = "PNG"
    tmp_img.save()
    bpy.data.images.remove(tmp_img)

    img = bpy.data.images.load(out_path, check_existing=False)
    img.name = name
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def box_blur_2d(arr: np.ndarray, radius: int, passes: int = 2) -> np.ndarray:
    out = arr.astype(np.float32)
    if radius <= 0:
        return out
    k = 2 * radius + 1
    for _ in range(passes):
        p = np.pad(out, ((0, 0), (radius, radius)), mode="edge")
        cs = np.cumsum(np.pad(p, ((0, 0), (1, 0)), mode="constant"), axis=1)
        out = (cs[:, k:] - cs[:, :-k]) / k
        p = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
        cs = np.cumsum(np.pad(p, ((1, 0), (0, 0)), mode="constant"), axis=0)
        out = (cs[k:, :] - cs[:-k, :]) / k
    return out


def height_to_normal_rgba(height_map: np.ndarray, strength: float = 2.0) -> np.ndarray:
    gx = np.roll(height_map, -1, axis=1) - np.roll(height_map, 1, axis=1)
    gy = np.roll(height_map, -1, axis=0) - np.roll(height_map, 1, axis=0)
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height_map, dtype=np.float32)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    h, w = height_map.shape
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, 0] = nx * inv * 0.5 + 0.5
    rgba[:, :, 1] = ny * inv * 0.5 + 0.5
    rgba[:, :, 2] = nz * inv * 0.5 + 0.5
    return rgba


def set_bsdf(bsdf, name: str, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def reset_mat(name: str):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out_n = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])
    return mat, nt, bsdf


def link_pbr_maps(nt, bsdf, img_albedo, img_orm=None, img_normal=None, normal_strength=0.4, img_emissive=None):
    if img_albedo is not None:
        t_c = nt.nodes.new("ShaderNodeTexImage"); t_c.image = img_albedo
        nt.links.new(t_c.outputs["Color"], bsdf.inputs["Base Color"])
    if img_orm is not None:
        t_o = nt.nodes.new("ShaderNodeTexImage"); t_o.image = img_orm
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t_o.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if img_normal is not None:
        t_n = nt.nodes.new("ShaderNodeTexImage"); t_n.image = img_normal
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(t_n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if img_emissive is not None:
        t_e = nt.nodes.new("ShaderNodeTexImage"); t_e.image = img_emissive
        nt.links.new(t_e.outputs["Color"], bsdf.inputs["Emission Color"])


# ---------- 统一骨架与网格构建 ----------

def build_armature(pmx_bones: list[dict], arm_name: str, scale: float, min_y: float):
    by_name = {b["name"]: b for b in pmx_bones}

    def pos_of(jp_name: str) -> Vector:
        p = by_name[jp_name]["pos"]
        return Vector((p[0] * scale, p[2] * scale, (p[1] - min_y) * scale))

    hip_head = pos_of("腰")
    spine_lower = pos_of("上半身")
    spine_chest = pos_of("上半身2")
    neck = pos_of("首")
    head_p = pos_of("頭")
    head_tip = pos_of("頭先")

    bone_specs = [
        ("hip", None, hip_head, spine_lower),
        ("spineLower", "hip", spine_lower, spine_chest),
        ("spineChest", "spineLower", spine_chest, neck),
        ("neckUpper", "spineChest", neck, head_p),
        ("head", "neckUpper", head_p, head_tip),
    ]

    for side, jp in (("L", "左"), ("R", "右")):
        thigh = pos_of(f"{jp}足")
        shin = pos_of(f"{jp}ひざ")
        foot = pos_of(f"{jp}足首")
        toe = pos_of(f"{jp}足先EX")
        bone_specs.extend([
            (f"Thigh_{side}", "hip", thigh, shin),
            (f"Shin_{side}", f"Thigh_{side}", shin, foot),
            (f"Foot_{side}", f"Shin_{side}", foot, toe),
            (f"Toe_{side}", f"Foot_{side}", toe, toe + Vector((0.0, -0.08, 0.0))),
        ])

    for side, jp in (("L", "左"), ("R", "右")):
        collar = pos_of(f"{jp}肩")
        upper = pos_of(f"{jp}腕")
        lower = pos_of(f"{jp}ひじ")
        hand = pos_of(f"{jp}手首")
        hand_tip = pos_of(f"{jp}中指１")
        bone_specs.extend([
            (f"Collar_{side}", "spineChest", collar, upper),
            (f"UpperArm_{side}", f"Collar_{side}", upper, lower),
            (f"LowerArm_{side}", f"UpperArm_{side}", lower, hand),
            (f"Hand_{side}", f"LowerArm_{side}", hand, hand_tip),
        ])
        finger_defs = [
            ("Thumb", [f"{jp}親指0", f"{jp}親指１", f"{jp}親指２"], f"{jp}親指先"),
            ("Index", [f"{jp}人指１", f"{jp}人指２", f"{jp}人指３"], f"{jp}人差指先"),
            ("Mid",   [f"{jp}中指１", f"{jp}中指２", f"{jp}中指３"], f"{jp}中指先"),
            ("Ring",  [f"{jp}薬指１", f"{jp}薬指２", f"{jp}薬指３"], f"{jp}薬指先"),
            ("Pinky", [f"{jp}小指１", f"{jp}小指２", f"{jp}小指３"], f"{jp}小指先"),
        ]
        for fname, seg_jps, tip_jp in finger_defs:
            pts = [pos_of(n) for n in seg_jps] + [pos_of(tip_jp)]
            for i in range(3):
                bname = f"{fname}{i + 1}_{side}"
                pname = f"Hand_{side}" if i == 0 else f"{fname}{i}_{side}"
                hp, tp = pts[i], pts[i + 1]
                if (tp - hp).length < 1e-4:
                    tp = hp + Vector((0.02 if side == "L" else -0.02, 0.0, -0.02))
                bone_specs.append((bname, pname, hp, tp))

    arm_data = bpy.data.armatures.new(arm_name)
    arm_obj = bpy.data.objects.new(arm_name, arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    edit_bones = {}
    bone_tips_gltf = {}
    for bname, pname, hp, tp in bone_specs:
        eb = arm_data.edit_bones.new(bname)
        eb.head = hp
        eb.tail = tp
        if pname and pname in edit_bones:
            eb.parent = edit_bones[pname]
            eb.use_connect = False
        edit_bones[bname] = eb
        bone_tips_gltf[bname] = [round(float(tp.x), 5), round(float(tp.z), 5), round(float(-tp.y), 5)]

    bpy.ops.object.mode_set(mode="OBJECT")
    arm_obj["bone_tips"] = bone_tips_gltf
    return arm_obj


def build_mesh(pmx: dict, mesh_name: str, arm_obj: bpy.types.Object, mat_map: dict, skip_mats: set[str], scale: float, min_y: float):
    verts, normals, uvs, weights, indices = pmx["verts"], pmx["normals"], pmx["uvs"], pmx["weights"], pmx["indices"]
    pmx_bones = pmx["bones"]

    used_old, old_to_new, faces_new, face_slots = [], {}, [], []
    slot_mats, mat_to_slot = [], {}
    seen_tris = set()

    for m in pmx["materials"]:
        mn = m["name"]
        if mn in skip_mats:
            continue
        bl_mat = mat_map.get(mn)
        if bl_mat is None:
            raise ValueError(f"{mesh_name} 缺少 PMX 材质映射: {mn}")
        if bl_mat.name not in mat_to_slot:
            mat_to_slot[bl_mat.name] = len(slot_mats)
            slot_mats.append(bl_mat)
        s_idx = mat_to_slot[bl_mat.name]

        start, count = m["index_start"], m["index_count"]
        for k in range(start, start + count, 3):
            i0, i1, i2 = indices[k], indices[k + 1], indices[k + 2]
            if i0 == i1 or i1 == i2 or i2 == i0:
                continue
            key = tuple(sorted((i0, i1, i2)))
            if key in seen_tris:
                continue
            seen_tris.add(key)
            tri = []
            for ov in (i0, i2, i1):
                nv = old_to_new.get(ov)
                if nv is None:
                    nv = len(used_old)
                    old_to_new[ov] = nv
                    used_old.append(ov)
                tri.append(nv)
            faces_new.append(tuple(tri))
            face_slots.append(s_idx)

    bl_verts, bl_normals = [], []
    for ov in used_old:
        px, py, pz = verts[ov]
        bl_verts.append((px * scale, pz * scale, (py - min_y) * scale))
        nx, ny, nz = normals[ov]
        nv = Vector((nx, nz, ny))
        nv = nv.normalized() if nv.length_squared > 1e-8 else Vector((0.0, -1.0, 0.0))
        bl_normals.append((nv.x, nv.y, nv.z))

    mesh = bpy.data.meshes.new(mesh_name)
    mesh.from_pydata(bl_verts, [], faces_new)
    mesh.update()
    for bm in slot_mats:
        mesh.materials.append(bm)
    mesh.polygons.foreach_set("material_index", face_slots)
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))

    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_data = uv_layer.data
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            ov = used_old[mesh.loops[li].vertex_index]
            u, v = uvs[ov]
            uv_data[li].uv = (u, 1.0 - v)

    aligned = 0
    for poly in mesh.polygons:
        n_avg = Vector((0.0, 0.0, 0.0))
        for vi in poly.vertices:
            n_avg += Vector(bl_normals[vi])
        if poly.normal.dot(n_avg) > 0:
            aligned += 1
    ratio = aligned / max(1, len(mesh.polygons))
    if ratio < 0.85:
        raise RuntimeError(f"{mesh_name} 面绕序与法线一致性过低: {ratio:.3f}")

    mesh.normals_split_custom_set_from_vertices(bl_normals)
    mesh.update()

    obj = bpy.data.objects.new(mesh_name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = arm_obj
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj

    bone_idx_to_std = {b["idx"]: PMX_TO_STD_BONE[b["name"]] for b in pmx_bones if b["name"] in PMX_TO_STD_BONE}
    vgroups = {s: obj.vertex_groups.new(name=s) for s in set(bone_idx_to_std.values())}

    unmapped = set()
    for nv, ov in enumerate(used_old):
        acc = {}
        for b_idx, w in weights[ov]:
            sn = bone_idx_to_std.get(b_idx)
            if not sn:
                unmapped.add(pmx_bones[b_idx]["name"])
                continue
            acc[sn] = acc.get(sn, 0.0) + w
        tw = sum(acc.values())
        if tw > 1e-6:
            for sn, w in acc.items():
                vgroups[sn].add([nv], w / tw, "REPLACE")
    if unmapped:
        raise RuntimeError(f"{mesh_name} 存在未映射带权重骨骼: {sorted(unmapped)}")
    return obj


def export_glb(out_path: str):
    bpy.context.view_layer.update()
    bpy.ops.outliner.orphans_purge(do_recursive=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=92,
        export_skins=True,
        export_animations=False,
        export_extras=True,
        export_attributes=True,
    )


# ---------- 1. 赛罗奥特曼 (zero.glb) ----------

def build_zero_materials(pmx_dir: str, tmp_dir: str):
    mats = {}

    # 主贴图 体.jpg（含蓝/红/银/线描细节/香槟浅金胸纹/纯黑槽）
    body_src = load_rgba_array(pmx_dir, "体.jpg")
    r, g, b = body_src[:, :, 0], body_src[:, :, 1], body_src[:, :, 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    sat = max_c - min_c
    lum = (r + g + b) / 3.0

    is_dark = np.clip((0.18 - max_c) / 0.12, 0.0, 1.0)
    is_red = np.clip((r - np.maximum(g, b) - 0.14) / 0.22, 0.0, 1.0) * (1.0 - is_dark)
    is_blue = np.clip((b - r - 0.12) / 0.22, 0.0, 1.0) * (1.0 - is_dark)
    is_cream = np.clip((np.minimum(r, g) - b - 0.08) / 0.14, 0.0, 1.0) * (1.0 - is_dark)
    is_silver = np.clip(1.0 - np.maximum(np.maximum(is_red, is_blue), np.maximum(is_cream, is_dark)), 0.0, 1.0)

    # 温和提亮至 PBR 标准反照率，忠实保留赛罗头雕/头镖/胸甲所有线描雕刻纹
    body_rgb = body_src[:, :, :3].copy()
    # 银色区（原图偏暗蓝灰 ~0.62）提亮至冷钛银，保留深灰线描对比度
    silver_lifted = np.clip(body_rgb * 1.26 + np.array([0.04, 0.05, 0.06], dtype=np.float32), 0.0, 0.96)
    # 红色区更鲜明饱和
    red_lifted = np.clip(body_rgb * np.array([1.22, 0.92, 0.90], dtype=np.float32), 0.0, 0.92)
    # 蓝色区更清澈赛罗深蓝
    blue_lifted = np.clip(body_rgb * np.array([0.92, 1.05, 1.24], dtype=np.float32), 0.0, 0.95)
    # 浅金/米白胸甲能量槽区
    cream_lifted = np.clip(body_rgb * np.array([1.05, 1.03, 0.94], dtype=np.float32), 0.0, 0.98)

    final_rgb = (
        is_silver[:, :, None] * silver_lifted
        + is_red[:, :, None] * red_lifted
        + is_blue[:, :, None] * blue_lifted
        + is_cream[:, :, None] * cream_lifted
        + is_dark[:, :, None] * (body_rgb * 0.5)
    )
    albedo_arr = np.ones_like(body_src)
    albedo_arr[:, :, :3] = np.clip(final_rgb, 0.0, 1.0)
    img_body = make_blender_image("zero_body_albedo", albedo_arr, tmp_dir, "sRGB")

    # 战衣/身体 ORM（银色半金属，红蓝皮套半哑光）
    suit_orm = np.ones_like(body_src)
    suit_orm[:, :, 0] = 1.0
    suit_orm[:, :, 1] = np.clip(is_silver * 0.28 + (is_red + is_blue) * 0.40 + is_dark * 0.65 + is_cream * 0.22, 0.18, 0.85)
    suit_orm[:, :, 2] = np.clip(is_silver * 0.52 + (is_red + is_blue) * 0.10 + is_cream * 0.45, 0.0, 0.85)
    img_suit_orm = make_blender_image("zero_suit_orm", suit_orm, tmp_dir, "Non-Color")

    # 硬甲 ORM（头盔、头镖、胸甲、手镯、CT底座：高冷钛金属反光）
    armor_orm = np.ones_like(body_src)
    armor_orm[:, :, 0] = 1.0
    armor_orm[:, :, 1] = np.clip(is_silver * 0.22 + (is_red + is_blue) * 0.26 + is_dark * 0.60 + is_cream * 0.18, 0.14, 0.80)
    armor_orm[:, :, 2] = np.clip(is_silver * 0.78 + (is_red + is_blue) * 0.45 + is_cream * 0.75, 0.05, 0.90)
    img_armor_orm = make_blender_image("zero_armor_orm", armor_orm, tmp_dir, "Non-Color")

    # 细腻雕刻线法线
    line_detail = np.clip(lum - box_blur_2d(lum, radius=2, passes=1), -0.15, 0.15) * is_silver
    img_body_norm = make_blender_image("zero_body_normal", height_to_normal_rgba(line_detail * 0.4, strength=1.8), tmp_dir, "Non-Color")

    mat_suit, nt, bsdf = reset_mat("Zero body suit")
    link_pbr_maps(nt, bsdf, img_body, img_suit_orm, img_body_norm, 0.30)
    set_bsdf(bsdf, "Coat Weight", 0.16); set_bsdf(bsdf, "Coat Roughness", 0.30)

    mat_armor, nt, bsdf = reset_mat("Zero body armor")
    link_pbr_maps(nt, bsdf, img_body, img_armor_orm, img_body_norm, 0.35)
    set_bsdf(bsdf, "Coat Weight", 0.38); set_bsdf(bsdf, "Coat Roughness", 0.12)

    # 胸甲能量发光条（微亮暖奶金）
    mat_prot_glow, nt, bsdf = reset_mat("Zero protector glow")
    link_pbr_maps(nt, bsdf, img_body, None, None, 0.0, img_body)
    set_bsdf(bsdf, "Roughness", 0.20); set_bsdf(bsdf, "Metallic", 0.20); set_bsdf(bsdf, "Emission Strength", 0.45)

    # 覗き穴（纯黑眼底槽）
    mat_hole, _, bsdf = reset_mat("Zero eye rim")
    set_bsdf(bsdf, "Base Color", (0.04, 0.05, 0.07, 1.0))
    set_bsdf(bsdf, "Roughness", 0.45); set_bsdf(bsdf, "Metallic", 0.3)

    # 赛罗锐利金橙复眼 (Zero eyes)
    eye_src = load_rgba_array(pmx_dir, "目発光.jpg")
    eye_bright = np.ones_like(eye_src)
    eye_bright[:, :, 0] = np.clip(eye_src[:, :, 0] * 1.06, 0.0, 1.0)
    eye_bright[:, :, 1] = np.clip(eye_src[:, :, 1] * 1.08, 0.0, 1.0)
    eye_bright[:, :, 2] = np.clip(eye_src[:, :, 2] * 0.92, 0.0, 1.0)
    img_eye = make_blender_image("zero_eye_albedo", eye_bright, tmp_dir, "sRGB")
    mat_eye, nt, bsdf = reset_mat("Zero eyes")
    link_pbr_maps(nt, bsdf, img_eye, None, None, 0.0, img_eye)
    set_bsdf(bsdf, "Roughness", 0.12); set_bsdf(bsdf, "Metallic", 0.04)
    set_bsdf(bsdf, "Emission Strength", 1.15); set_bsdf(bsdf, "Coat Weight", 0.9); set_bsdf(bsdf, "Coat Roughness", 0.05)

    # 额头翡翠绿光束灯 (Zero forehead crystal)
    mat_beam_lamp, _, bsdf = reset_mat("Zero forehead crystal")
    set_bsdf(bsdf, "Base Color", (0.18, 0.95, 0.42, 1.0))
    set_bsdf(bsdf, "Emission Color", (0.12, 0.95, 0.38, 1.0))
    set_bsdf(bsdf, "Emission Strength", 1.5)
    set_bsdf(bsdf, "Roughness", 0.08); set_bsdf(bsdf, "Metallic", 0.10); set_bsdf(bsdf, "Coat Weight", 1.0)

    # 终极手镯发光青蓝宝石 (Zero bracelet crystal)
    mat_brace_glow, _, bsdf = reset_mat("Zero bracelet crystal")
    set_bsdf(bsdf, "Base Color", (0.35, 0.90, 1.0, 1.0))
    set_bsdf(bsdf, "Emission Color", (0.20, 0.85, 1.0, 1.0))
    set_bsdf(bsdf, "Emission Strength", 1.35)
    set_bsdf(bsdf, "Roughness", 0.08); set_bsdf(bsdf, "Metallic", 0.12); set_bsdf(bsdf, "Coat Weight", 1.0)

    # 胸口彩色计时器 (Zero color timer)
    ct_src = load_rgba_array(pmx_dir, "ゼロカラータイマー.png")
    ct_lum = ct_src[:, :, :3].mean(axis=2)
    ct_bright = np.clip(0.55 + ct_lum * 0.55, 0.38, 1.0)
    ct_col = np.ones_like(ct_src)
    ct_col[:, :, 0] = ct_bright * 0.86; ct_col[:, :, 1] = ct_bright * 0.96; ct_col[:, :, 2] = ct_bright
    img_ct = make_blender_image("zero_timer_albedo", ct_col, tmp_dir, "sRGB")
    img_ct_n = make_blender_image("zero_timer_normal", height_to_normal_rgba(ct_lum * 0.35, strength=2.2), tmp_dir, "Non-Color")
    mat_timer, nt, bsdf = reset_mat("Zero color timer")
    link_pbr_maps(nt, bsdf, img_ct, None, img_ct_n, 0.55)
    set_bsdf(bsdf, "Roughness", 0.10); set_bsdf(bsdf, "Metallic", 0.08)
    set_bsdf(bsdf, "Emission Color", (0.25, 0.92, 1.0, 1.0)); set_bsdf(bsdf, "Emission Strength", 1.45)
    set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    mats.update({
        "マスク": mat_armor,
        "覗き穴": mat_hole,
        "プロテクター": mat_armor,
        "プロテクター発光": mat_prot_glow,
        "体": mat_suit,
        "手": mat_armor,
        "スラッガー": mat_armor,
        "ブレスレット": mat_armor,
        "ブレスレット内側": mat_armor,
        "CT土台": mat_armor,
        "目透明": mat_eye,
        "ビームランプ発光": mat_beam_lamp,
        "ブレスレット発光": mat_brace_glow,
        "CT透明": mat_timer,
    })
    return mats


# ---------- 2. 戴拿奥特曼 (dyna.glb, 闪亮型 Flash Type) ----------

def build_dyna_materials(pmx_dir: str, tmp_dir: str):
    mats = {}

    # 1. 战衣主体 Dyna body Flash（兼容 hero.ts 强壮型 all-red / 奇迹型 all-cobalt 像素重映射）
    suit_src = load_rgba_array(pmx_dir, "本体.png")
    r, g, b = suit_src[:, :, 0], suit_src[:, :, 1], suit_src[:, :, 2]
    w_red = np.clip((r - np.maximum(g, b) - 0.10) / 0.18, 0.0, 1.0)
    w_blue = np.clip((b - r - 0.08) / 0.16, 0.0, 1.0)
    w_silver = np.clip(1.0 - np.maximum(w_red, w_blue), 0.0, 1.0)
    w_sum = np.maximum(w_red + w_blue + w_silver, 1e-5)
    wr, wb, ws = w_red / w_sum, w_blue / w_sum, w_silver / w_sum

    # 戴拿闪亮型 1997 经典配色：浓正红 + 深邃钴蓝 + 清亮冷钛银（100% 满足 all-red / all-cobalt 条件）
    col_red = np.array([0.72, 0.11, 0.15], dtype=np.float32)
    col_blue = np.array([0.14, 0.27, 0.58], dtype=np.float32)
    col_silver = np.array([0.84, 0.87, 0.91], dtype=np.float32)
    suit_rgb = wr[:, :, None] * col_red + wb[:, :, None] * col_blue + ws[:, :, None] * col_silver

    # 柔和接缝凹槽
    label = np.zeros(r.shape, dtype=np.int32)
    label[ws > 0.5] = 1; label[wb > 0.5] = 2; label[wr > 0.5] = 3
    seam = np.zeros(r.shape, dtype=np.float32)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        seam = np.maximum(seam, (label != np.roll(np.roll(label, dy, axis=0), dx, axis=1)).astype(np.float32))
    seam_groove = np.clip(box_blur_2d(seam, radius=2, passes=3) * 1.9, 0.0, 1.0)
    seam_ao = np.clip(1.0 - seam_groove * 0.12, 0.84, 1.0)

    suit_albedo = np.ones_like(suit_src)
    suit_albedo[:, :, :3] = np.clip(suit_rgb * seam_ao[:, :, None], 0.0, 1.0)
    img_suit = make_blender_image("dyna_suit_albedo", suit_albedo, tmp_dir, "sRGB")

    suit_orm = np.ones_like(suit_src)
    suit_orm[:, :, 0] = seam_ao
    suit_orm[:, :, 1] = np.clip(ws * 0.28 + (wr + wb) * 0.42 + seam_groove * 0.12, 0.20, 0.85)
    suit_orm[:, :, 2] = np.clip(ws * 0.48 + (wr + wb) * 0.08 - seam_groove * 0.10, 0.0, 0.85)
    img_suit_orm = make_blender_image("dyna_suit_orm", suit_orm, tmp_dir, "Non-Color")
    img_suit_n = make_blender_image("dyna_suit_normal", height_to_normal_rgba(-seam_groove * 0.18, strength=1.8), tmp_dir, "Non-Color")

    mat_suit, nt, bsdf = reset_mat("Dyna body Flash")
    link_pbr_maps(nt, bsdf, img_suit, img_suit_orm, img_suit_n, 0.28)
    set_bsdf(bsdf, "Coat Weight", 0.15); set_bsdf(bsdf, "Coat Roughness", 0.32)

    # 辅助函数：将含银/金/黑的贴图转为 PBR 铝银+24K香槟金+深黑槽
    def make_silver_gold_mat(tex_name: str, mat_name: str):
        src = load_rgba_array(pmx_dir, tex_name)
        sr, sg, sb = src[:, :, 0], src[:, :, 1], src[:, :, 2]
        slum = (sr + sg + sb) / 3.0
        is_blk = np.clip((0.22 - slum) / 0.14, 0.0, 1.0)
        is_gld = np.clip((sr - sb - 0.10) / 0.16, 0.0, 1.0) * (1.0 - is_blk)
        is_sil = np.clip(1.0 - np.maximum(is_blk, is_gld), 0.0, 1.0)
        c_sil = np.array([0.85, 0.88, 0.92], dtype=np.float32)
        c_gld = np.array([0.96, 0.76, 0.26], dtype=np.float32)
        c_blk = np.array([0.05, 0.06, 0.08], dtype=np.float32)
        out = np.ones_like(src)
        out[:, :, :3] = np.clip(is_sil[:, :, None] * c_sil + is_gld[:, :, None] * c_gld + is_blk[:, :, None] * c_blk, 0.0, 1.0)
        orm = np.ones_like(src)
        orm[:, :, 0] = np.clip(1.0 - is_blk * 0.6, 0.3, 1.0)
        orm[:, :, 1] = np.clip(is_sil * 0.24 + is_gld * 0.20 + is_blk * 0.65, 0.16, 0.85)
        orm[:, :, 2] = np.clip(is_sil * 0.74 + is_gld * 0.86 + is_blk * 0.08, 0.05, 0.92)
        tag = mat_name.lower().replace(" ", "_")
        img_a = make_blender_image(f"{tag}_albedo", out, tmp_dir, "sRGB")
        img_o = make_blender_image(f"{tag}_orm", orm, tmp_dir, "Non-Color")
        mat, nt, bsdf = reset_mat(mat_name)
        link_pbr_maps(nt, bsdf, img_a, img_o)
        set_bsdf(bsdf, "Coat Weight", 0.35); set_bsdf(bsdf, "Coat Roughness", 0.13)
        return mat

    mat_mask = make_silver_gold_mat("マスク.png", "Dyna head mask")
    mat_prot = make_silver_gold_mat("プロテクター.png", "Dyna body protector")
    mat_silver = make_silver_gold_mat("手足肩.png", "Dyna body silver")

    # 戴拿蜂窝复眼 (Dyna eyes)
    bump_src = load_rgba_array(pmx_dir, "目凹凸.png")
    b_lum = bump_src[:, :, :3].mean(axis=2)
    b_clean = np.where(b_lum < 0.65, box_blur_2d(b_lum, radius=3, passes=2), b_lum)
    facet = np.clip(0.86 + (b_clean - 0.78) * 1.1, 0.74, 1.0)
    eye_col = np.ones_like(bump_src)
    # 戴拿标志性象牙暖白金复眼
    eye_col[:, :, 0] = np.clip(facet * 1.02, 0.0, 1.0)
    eye_col[:, :, 1] = np.clip(facet * 0.96, 0.0, 1.0)
    eye_col[:, :, 2] = np.clip(facet * 0.76, 0.0, 1.0)
    img_eye = make_blender_image("dyna_eye_albedo", eye_col, tmp_dir, "sRGB")
    img_eye_n = make_blender_image("dyna_eye_normal", height_to_normal_rgba(b_clean * 0.75, strength=2.6), tmp_dir, "Non-Color")
    mat_eye, nt, bsdf = reset_mat("Dyna eyes")
    link_pbr_maps(nt, bsdf, img_eye, None, img_eye_n, 0.55, img_eye)
    set_bsdf(bsdf, "Roughness", 0.12); set_bsdf(bsdf, "Metallic", 0.05)
    set_bsdf(bsdf, "Emission Strength", 1.02); set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    # 额头宝石水晶 (Dyna forehead crystal)
    ct_src = load_rgba_array(pmx_dir, "カラータイマー.png")
    ct_lum = ct_src[:, :, :3].mean(axis=2)
    ct_bright = np.clip(0.55 + ct_lum * 0.58, 0.38, 1.0)
    ct_col = np.ones_like(ct_src)
    ct_col[:, :, 0] = ct_bright * 0.84; ct_col[:, :, 1] = ct_bright * 0.95; ct_col[:, :, 2] = ct_bright
    img_ct = make_blender_image("dyna_timer_albedo", ct_col, tmp_dir, "sRGB")
    img_ct_n = make_blender_image("dyna_timer_normal", height_to_normal_rgba(ct_lum * 0.45, strength=2.4), tmp_dir, "Non-Color")

    mat_crys, nt, bsdf = reset_mat("Dyna forehead crystal")
    link_pbr_maps(nt, bsdf, img_ct, None, img_ct_n, 0.45)
    set_bsdf(bsdf, "Roughness", 0.08); set_bsdf(bsdf, "Metallic", 0.14)
    set_bsdf(bsdf, "Emission Color", (0.35, 0.80, 1.0, 1.0)); set_bsdf(bsdf, "Emission Strength", 1.25)
    set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    mat_timer, nt, bsdf = reset_mat("Dyna color timer")
    link_pbr_maps(nt, bsdf, img_ct, None, img_ct_n, 0.65)
    set_bsdf(bsdf, "Roughness", 0.10); set_bsdf(bsdf, "Metallic", 0.08)
    set_bsdf(bsdf, "Emission Color", (0.25, 0.82, 1.0, 1.0)); set_bsdf(bsdf, "Emission Strength", 1.45)
    set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    mats.update({
        "マスク": mat_mask,
        "額クリスタル": mat_crys,
        "額金": mat_mask,
        "目の中": mat_mask,
        "体": mat_suit,
        "目発光": mat_eye,
        "肩手足": mat_silver,
        "プロテクター": mat_prot,
        "カラータイマー": mat_prot,
        "カラータイマー青": mat_timer,
    })
    return mats


# ---------- 3. 泽塔奥特曼原生形态 (zeta.glb) ----------

def build_zeta_materials(pmx_dir: str, tmp_dir: str):
    mats = {}

    # 1. 头雕面具 (Zeta head mask, 含精致圆孔耳饰与嘴线)
    mask_src = load_rgba_array(pmx_dir, "ゼットマスク.png")
    mlum = mask_src[:, :, :3].mean(axis=2)
    is_blk = np.clip((0.25 - mlum) / 0.18, 0.0, 1.0)
    is_hi = np.clip((mlum - 0.78) / 0.18, 0.0, 1.0)
    mask_out = np.ones_like(mask_src)
    # 柔和提亮为清亮冷钛银，保留耳孔浮雕黑白立体线
    mask_out[:, :, 0] = np.clip(0.82 * (1.0 - is_blk * 0.88) + is_hi * 0.15, 0.04, 0.98)
    mask_out[:, :, 1] = np.clip(0.86 * (1.0 - is_blk * 0.88) + is_hi * 0.13, 0.05, 0.99)
    mask_out[:, :, 2] = np.clip(0.92 * (1.0 - is_blk * 0.88) + is_hi * 0.08, 0.06, 1.00)
    mask_orm = np.ones_like(mask_src)
    mask_orm[:, :, 0] = np.clip(1.0 - is_blk * 0.65, 0.25, 1.0)
    mask_orm[:, :, 1] = np.clip(0.22 + is_blk * 0.55, 0.16, 0.82)
    mask_orm[:, :, 2] = np.clip(0.76 * (1.0 - is_blk * 0.85), 0.08, 0.85)
    img_mask = make_blender_image("zeta_mask_albedo", mask_out, tmp_dir, "sRGB")
    img_mask_orm = make_blender_image("zeta_mask_orm", mask_orm, tmp_dir, "Non-Color")

    mat_mask, nt, bsdf = reset_mat("Zeta head mask")
    link_pbr_maps(nt, bsdf, img_mask, img_mask_orm)
    set_bsdf(bsdf, "Coat Weight", 0.36); set_bsdf(bsdf, "Coat Roughness", 0.12)

    # 2. 身体战衣 (Zeta body suit: 冰银 + 泽塔钴蓝 + 碳黑装甲 + 猩红点缀)
    body_src = load_rgba_array(pmx_dir, "ボディ.png")
    r, g, b = body_src[:, :, 0], body_src[:, :, 1], body_src[:, :, 2]
    lum = (r + g + b) / 3.0
    w_black = np.clip((0.18 - lum) / 0.12, 0.0, 1.0)
    w_red = np.clip((r - np.maximum(g, b) - 0.18) / 0.22, 0.0, 1.0) * (1.0 - w_black)
    w_blue = np.clip((b - r - 0.12) / 0.18, 0.0, 1.0) * (1.0 - w_black)
    w_silver = np.clip(1.0 - np.maximum(w_black, np.maximum(w_red, w_blue)), 0.0, 1.0)
    w_sum = np.maximum(w_black + w_red + w_blue + w_silver, 1e-5)
    wk, wr, wb, ws = w_black / w_sum, w_red / w_sum, w_blue / w_sum, w_silver / w_sum

    col_silver = np.array([0.82, 0.87, 0.94], dtype=np.float32)  # 冰冷银白
    col_blue = np.array([0.14, 0.42, 0.74], dtype=np.float32)    # 泽塔清爽苍蓝
    col_black = np.array([0.07, 0.08, 0.11], dtype=np.float32)   # 暗碳纤维黑
    col_red = np.array([0.82, 0.12, 0.15], dtype=np.float32)     # 猩红点缀
    body_rgb = (
        ws[:, :, None] * col_silver
        + wb[:, :, None] * col_blue
        + wk[:, :, None] * col_black
        + wr[:, :, None] * col_red
    )
    body_albedo = np.ones_like(body_src)
    body_albedo[:, :, :3] = np.clip(body_rgb, 0.0, 1.0)
    body_orm = np.ones_like(body_src)
    body_orm[:, :, 0] = 1.0
    body_orm[:, :, 1] = np.clip(ws * 0.26 + wb * 0.36 + wk * 0.34 + wr * 0.36, 0.18, 0.80)
    body_orm[:, :, 2] = np.clip(ws * 0.56 + wb * 0.22 + wk * 0.30 + wr * 0.12, 0.05, 0.85)
    img_body = make_blender_image("zeta_body_albedo", body_albedo, tmp_dir, "sRGB")
    img_body_orm = make_blender_image("zeta_body_orm", body_orm, tmp_dir, "Non-Color")

    mat_body, nt, bsdf = reset_mat("Zeta body suit")
    link_pbr_maps(nt, bsdf, img_body, img_body_orm)
    set_bsdf(bsdf, "Coat Weight", 0.20); set_bsdf(bsdf, "Coat Roughness", 0.26)

    # 3. 泽塔钻石棱镜复眼 (Zeta eyes)
    eye_src = load_rgba_array(pmx_dir, "目.png")
    eye_lum = eye_src[:, :, :3].mean(axis=2)
    eye_col = np.ones_like(eye_src)
    # 泽塔标志性冰白微青钻石复眼
    eye_col[:, :, 0] = np.clip(eye_src[:, :, 0] * 0.96 + 0.04, 0.0, 1.0)
    eye_col[:, :, 1] = np.clip(eye_src[:, :, 1] * 0.99 + 0.03, 0.0, 1.0)
    eye_col[:, :, 2] = np.clip(eye_src[:, :, 2] * 1.02 + 0.04, 0.0, 1.0)
    img_eye = make_blender_image("zeta_eye_albedo", eye_col, tmp_dir, "sRGB")
    img_eye_n = make_blender_image("zeta_eye_normal", height_to_normal_rgba(eye_lum * 0.35, strength=2.0), tmp_dir, "Non-Color")

    mat_eye, nt, bsdf = reset_mat("Zeta eyes")
    link_pbr_maps(nt, bsdf, img_eye, None, img_eye_n, 0.45, img_eye)
    set_bsdf(bsdf, "Roughness", 0.10); set_bsdf(bsdf, "Metallic", 0.05)
    set_bsdf(bsdf, "Emission Strength", 1.08); set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    # 4. 泽塔胸口 Z 字浮雕彩色计时器 (Zeta color timer)
    ct_src = load_rgba_array(pmx_dir, "ゼットCT.png")
    ct_lum = ct_src[:, :, :3].mean(axis=2)
    ct_bright = np.clip(0.50 + ct_lum * 0.60, 0.35, 1.0)
    ct_col = np.ones_like(ct_src)
    ct_col[:, :, 0] = ct_bright * 0.82; ct_col[:, :, 1] = ct_bright * 0.95; ct_col[:, :, 2] = ct_bright
    img_ct = make_blender_image("zeta_timer_albedo", ct_col, tmp_dir, "sRGB")
    img_ct_n = make_blender_image("zeta_timer_normal", height_to_normal_rgba(ct_lum * 0.45, strength=2.6), tmp_dir, "Non-Color")

    mat_timer, nt, bsdf = reset_mat("Zeta color timer")
    link_pbr_maps(nt, bsdf, img_ct, None, img_ct_n, 0.65)
    set_bsdf(bsdf, "Roughness", 0.10); set_bsdf(bsdf, "Metallic", 0.08)
    set_bsdf(bsdf, "Emission Color", (0.22, 0.88, 1.0, 1.0)); set_bsdf(bsdf, "Emission Strength", 1.45)
    set_bsdf(bsdf, "Coat Weight", 1.0); set_bsdf(bsdf, "Coat Roughness", 0.04)

    mats.update({
        "マスク": mat_mask,
        "目": mat_eye,
        "体": mat_body,
        "CT": mat_timer,
    })
    return mats


def convert_hero(hero_id: str, rel_pmx: str, mesh_name: str, arm_name: str, skip_mats: set[str], mat_builder):
    pmx_path = resolve_nfc_path(ASSETS_ROOT, rel_pmx)
    pmx_dir = os.path.dirname(pmx_path)
    out_glb = os.path.join(OUT_DIR, f"{hero_id}.glb")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    pmx = parse_pmx(pmx_path)
    ys = [v[1] for v in pmx["verts"]]
    min_y, max_y = min(ys), max(ys)
    scale = 3.1 / (max_y - min_y)

    with tempfile.TemporaryDirectory(prefix=f"rindou_{hero_id}_") as tmp_dir:
        mat_map = mat_builder(pmx_dir, tmp_dir)
        arm_obj = build_armature(pmx["bones"], arm_name, scale, min_y)
        body_obj = build_mesh(pmx, mesh_name, arm_obj, mat_map, skip_mats, scale, min_y)
        export_glb(out_glb)
        print(
            f"✓ {hero_id}.glb 导出完成: {os.path.getsize(out_glb) // 1024} KB "
            f"(verts={len(body_obj.data.vertices)}, tris={len(body_obj.data.polygons)}, bones={len(arm_obj.data.bones)})"
        )


def main():
    convert_hero(
        hero_id="zero",
        rel_pmx="リンドウ式ゼロ2.0/リンドウ式ゼロ2.0.pmx",
        mesh_name="ZeroBody",
        arm_name="ZeroArmature",
        skip_mats={"目発光", "ビームランプ透明", "CT青発光", "CT赤発光", "CT灰", "ツインシュート用"},
        mat_builder=build_zero_materials,
    )
    convert_hero(
        hero_id="dyna",
        rel_pmx="リンドウ式ダイナVer2.2/リンドウ式ダイナ2.1.pmx",
        mesh_name="DynaBody",
        arm_name="DynaArmature",
        skip_mats={"額カバー", "目カバー", "カラータイマー赤", "カラータイマー灰", "カラータイマーカバー"},
        mat_builder=build_dyna_materials,
    )
    convert_hero(
        hero_id="zeta",
        rel_pmx="リンドウ式ゼットオリジナル/リンドウ式ゼットオリジナル.pmx",
        mesh_name="ZetaBody",
        arm_name="ZetaArmature",
        skip_mats={"目発光用", "CT青", "CT赤", "CT灰"},
        mat_builder=build_zeta_materials,
    )


if __name__ == "__main__":
    main()
