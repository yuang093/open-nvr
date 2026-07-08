/**
 * Object class filter for YOLO detection.
 *
 * Lets the user pick which COCO classes to keep in detection output. Backed
 * by two layers of config:
 *   1. Global default in `Settings.aiEnabledClasses` (applies to all cameras
 *      that don't have an explicit override).
 *   2. Per-camera override in `CameraEntry.enabledClasses`.
 *
 * Resolution chain: camera -> global -> default (all enabled).
 */

/** COCO class ids that the UI exposes as individual toggles (0..8). */
export const INDIVIDUAL_CLASS_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Human-readable labels for the individual class ids, in UI order. */
export const INDIVIDUAL_CLASS_LABELS: ReadonlyArray<{ id: number; label: string }> = [
    { id: 0, label: 'person' },
    { id: 1, label: 'bicycle' },
    { id: 2, label: 'car' },
    { id: 3, label: 'motorcycle' },
    { id: 4, label: 'airplane' },
    { id: 5, label: 'bus' },
    { id: 6, label: 'train' },
    { id: 7, label: 'truck' },
    { id: 8, label: 'boat' },
];

/**
 * User-facing filter spec.
 *  - individual: subset of [0..8] the user wants to keep. Order is not significant.
 *  - others: whether to keep any class id >= 9 (COCO has 80 classes).
 */
export interface EnabledClasses {
    individual: number[];
    others: boolean;
}

/** Default = all classes enabled. Preserves behavior when nothing configured. */
export function defaultEnabledClasses(): EnabledClasses {
    return {
        individual: INDIVIDUAL_CLASS_IDS.slice(),
        others: true,
    };
}

/**
 * Resolve effective class filter for a camera.
 * Fallback chain: camera.enabledClasses -> globalSettings -> default
 *
 * Returns null when the resolved filter would filter out *everything*
 * (i.e., empty individual list AND others=false). Callers should treat
 * null as "do not run YOLO at all" — the Python side will still receive
 * the explicit CSV "OTHER" / "" so it can log accordingly.
 */
export function resolveEnabledClasses(
    camera: { enabledClasses?: EnabledClasses | null } | null | undefined,
    globalSettings: EnabledClasses | null | undefined,
): EnabledClasses | null {
    const resolved =
        (camera && camera.enabledClasses) ||
        globalSettings ||
        defaultEnabledClasses();

    if ((!resolved.individual || resolved.individual.length === 0) && !resolved.others) {
        return null;
    }
    return resolved;
}

/**
 * Serialize an EnabledClasses filter to a CSV string that the Python
 * detector understands.
 *  - empty list of individuals + others=true  ->  "0,1,2,3,4,5,6,7,8,OTHER"
 *  - explicit list                            ->  "0,1,2,3,7,8" (etc.)
 *  - others=false, no individuals             ->  "" (caller should skip detection)
 *
 * The "OTHER" sentinel is a non-numeric token the Python side recognizes as
 * "all class ids >= 9".
 */
export function enabledClassesToCsv(ec: EnabledClasses | null | undefined): string {
    if (!ec) return '';
    const parts: string[] = [];
    for (const id of ec.individual || []) {
        if (INDIVIDUAL_CLASS_IDS.includes(id as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)) {
            parts.push(String(id));
        }
    }
    if (ec.others) parts.push('OTHER');
    return parts.join(',');
}
