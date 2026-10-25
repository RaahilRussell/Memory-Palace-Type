"""Bounded crop and observation rules, independently testable without a model."""
from __future__ import annotations
import math


def valid_subject_box(box):
    return (isinstance(box, (tuple, list)) and len(box) == 4 and
            all(isinstance(x, (int, float)) and math.isfinite(x) and 0 <= x <= 1 for x in box) and
            box[0] < box[2] and box[1] < box[3])


def proposals(width, height, subjects, faces, limit=48):
    """Schedule each segmented person before face/grid searches can use the budget.

    A tight and a contextual crop support hands on the chest/face and cropped or
    seated bodies. Square padding includes arm gestures; it is never interpreted
    as evidence that the person is standing or has a particular body height.
    """
    rectangles = [(0, 0, width, height)]
    valid = [box for box in subjects if valid_subject_box(box)][:24]
    for padding in [.07, .22]:
        for top, left, bottom, right in valid:
            dx, dy = (right - left) * padding, (bottom - top) * padding
            rectangles.append((int((left - dx) * width), int((top - dy) * height),
                               math.ceil((right + dx) * width), math.ceil((bottom + dy) * height)))
    for left, top, right, bottom in faces[:24]:
        side = max(right - left, bottom - top) * 4.2
        cx, cy = (left + right) / 2, (top + bottom) / 2
        rectangles.append((int(cx - side * .5), int(cy - side * .23),
                           math.ceil(cx + side * .5), math.ceil(cy + side * .77)))
    for left in [0, .2, .4, .6]:
        for top in [0, .2, .4]:
            rectangles.append((int(left * width), int(top * height),
                               math.ceil((left + .4) * width), math.ceil((top + .6) * height)))
    seen = set()
    for left, top, right, bottom in rectangles:
        rect = max(0, left), max(0, top), min(width, right), min(height, bottom)
        if rect in seen or rect[2] - rect[0] < 32 or rect[3] - rect[1] < 32:
            continue
        seen.add(rect)
        yield rect
        if len(seen) >= limit:
            return


def observation_score(confidences):
    """Accept visible upper bodies even when the hips are behind a table.

    This retains the model's individual confidence values. It cannot convert
    hidden hips or hands into observations or accept a face-only body proposal.
    """
    if len(confidences) != 33 or any(not math.isfinite(c) or not 0 <= c <= 1 for c in confidences):
        return None
    torso = [confidences[i] for i in [11, 12, 23, 24]]
    torso_score = sum(torso) / 4
    if torso_score >= .42 and sum(c >= .45 for c in torso) >= 2:
        return torso_score
    shoulders = min(confidences[11], confidences[12])
    arm_evidence = max(confidences[i] for i in [13, 14, 15, 16])
    if shoulders >= .48 and (confidences[0] >= .6 or arm_evidence >= .6):
        return .7 * (confidences[11] + confidences[12]) / 2 + .3 * arm_evidence
    return None
