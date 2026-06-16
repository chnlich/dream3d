"""Shared axis-aligned bounding-box geometry for layout and geometry checks.

Mirrors src/scene/bbox.ts: one notion of footprint, half-extents, and minimum
clearance between footprints.
"""

from scene.schema import SceneObject, Vec3

# Meters of clearance to leave between two footprints.
SEPARATION_GAP = 0.05


def half_extents(obj: SceneObject) -> Vec3:
    """Half-extents of an object's axis-aligned bounding box."""
    s = obj.transform.scale
    return (
        (obj.approx_size[0] * s) / 2,
        (obj.approx_size[1] * s) / 2,
        (obj.approx_size[2] * s) / 2,
    )


def footprint_penetration(a: SceneObject, b: SceneObject) -> dict[str, float]:
    """Footprint overlap of a and b on each horizontal axis.

    A positive value on BOTH axes means the footprints overlap. A value <= 0 on
    either axis means they are already clear on that axis.
    """
    ah = half_extents(a)
    bh = half_extents(b)
    ax, _, az = a.transform.position
    bx, _, bz = b.transform.position
    return {
        "x": ah[0] + bh[0] + SEPARATION_GAP - abs(ax - bx),
        "z": ah[2] + bh[2] + SEPARATION_GAP - abs(az - bz),
    }
