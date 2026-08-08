/**
 * Turning MediaPipe face landmarks into a metric head position.
 *
 * The version this replaces used `landmarks[1]` (the nose tip) and passed its
 * `z` component straight through as a "distance factor". Both halves are wrong:
 *
 *   - `nose.z` is not a distance. MediaPipe documents z as a landmark's depth
 *     *relative to the centre of the head*, in roughly the same normalized
 *     scale as x, with the sign convention "smaller is closer". It is a few
 *     hundredths of a unit for every pose a human can hold in front of a
 *     laptop, and it does not change when you lean in or out — the head centre
 *     is the origin, so the whole head translating towards the camera leaves it
 *     almost untouched. Multiplying it by 5.0 and adding 2.5, as the viewer
 *     did, produced a camera distance that hovered near the base value and
 *     twitched with nose orientation. The depth axis simply did not work.
 *   - The nose tip is the worst landmark on the face for a magic window. It is
 *     the point that moves most under head *rotation*, so merely turning to
 *     look at something swung the viewpoint as if you had physically slid
 *     sideways. A magic window wants the position of the EYE. The midpoint of
 *     the two outer eye corners is the closest thing the mesh offers to a
 *     cyclopean eye, and it is nearly stationary under yaw and pitch.
 *
 * The replacement is ordinary pinhole photogrammetry against a body dimension
 * with a known population mean: the outer-canthus-to-outer-canthus span
 * ("biocular breadth"), landmarks 33 and 263, which is ~90 mm in adults and
 * varies far less between people than face length or head width. For an object
 * of known width `W` spanning a fraction `s` of the image width in a camera of
 * horizontal field of view `H`:
 *
 *     W / D = 2 * s * tan(H / 2)   =>   D = W / (2 * s * tan(H / 2))
 *
 * and the same relation run backwards converts the eye midpoint's normalized
 * image coordinates into metres off the optical axis. The absolute scale is
 * only as good as the assumed `H` and `W`, but neither error matters: the
 * recentre action divides everything through by the distance measured at
 * calibration, so a 20% error in the assumed webcam FOV becomes a 20% error in
 * the parallax gain, which is exactly what the sensitivity slider is for.
 */

/** One MediaPipe `NormalizedLandmark`. x and y are image fractions; z is described above. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/**
 * MediaPipe canonical face mesh indices for the two outer eye corners. Present
 * in both the 468-point mesh and the 478-point (iris-refined) variant, so this
 * does not depend on which `.task` bundle is configured. The iris centres
 * (468/473) would be a slightly better anchor but only exist in the refined
 * model.
 */
export const OUTER_EYE_CORNER_A = 33;
export const OUTER_EYE_CORNER_B = 263;

/**
 * Mean adult outer-canthal (biocular) breadth. Anthropometric surveys put this
 * near 88-92 mm across populations and sexes; interpupillary distance, the
 * number people usually reach for, is ~63 mm and is NOT what landmarks 33/263
 * measure.
 */
export const DEFAULT_BIOCULAR_WIDTH_M = 0.09;

/**
 * Assumed horizontal field of view of the webcam, in degrees. Laptop and
 * external webcams cluster around 55-78; 60 is a safe middle. There is no way
 * to query the true value from `getUserMedia` — the media track settings expose
 * resolution and frame rate, never optics.
 */
export const DEFAULT_CAMERA_HFOV_DEG = 60;

export interface HeadPoseEstimateOptions {
  /** Video frame width / height. Needed because MediaPipe normalizes x by width and y by height. */
  aspect: number;
  cameraHFovDeg?: number;
  biocularWidthM?: number;
}

export interface RawHeadPose {
  /** Eye-midpoint x in the raw (unmirrored) camera image, 0..1. For the preview overlay. */
  imageX: number;
  /** Eye-midpoint y in the raw camera image, 0..1. */
  imageY: number;
  /** Metres to the viewer's own right of the camera axis. */
  xMeters: number;
  /** Metres above the camera axis. */
  yMeters: number;
  /** Metres from the camera. */
  distanceMeters: number;
  /** The measured eye span, in image-width units. Diagnostic; small = far away. */
  span: number;
}

/** Below this the "face" is a few pixels wide and the distance estimate is noise. */
const MIN_SPAN = 1e-3;
/** Nobody uses a desktop from 4 m away, and nothing focuses at 10 cm. */
const MIN_DISTANCE_M = 0.15;
const MAX_DISTANCE_M = 4.0;

const isFiniteLandmark = (l: Landmark | undefined): l is Landmark =>
  !!l && Number.isFinite(l.x) && Number.isFinite(l.y);

/**
 * @returns the metric head pose, or null when the landmark set cannot support
 *          one (missing points, a degenerate span). Returning null rather than
 *          a garbage pose is what lets the hook report "no face" honestly
 *          instead of driving the camera off a division by ~zero.
 */
export const estimateHeadPose = (
  landmarks: Landmark[] | undefined,
  { aspect, cameraHFovDeg = DEFAULT_CAMERA_HFOV_DEG, biocularWidthM = DEFAULT_BIOCULAR_WIDTH_M }:
    HeadPoseEstimateOptions,
): RawHeadPose | null => {
  if (!landmarks || !(aspect > 0)) return null;
  const a = landmarks[OUTER_EYE_CORNER_A];
  const b = landmarks[OUTER_EYE_CORNER_B];
  if (!isFiniteLandmark(a) || !isFiniteLandmark(b)) return null;

  // Everything is converted into image-WIDTH units before being measured.
  // MediaPipe normalizes y by the frame height, so on a 16:9 webcam one unit of
  // y is 16/9 times as many pixels as one unit of x; mixing them unconverted
  // makes the measured eye span depend on head roll, and the viewer dollies
  // backwards every time you tilt your head.
  const dx = b.x - a.x;
  const dy = (b.y - a.y) / aspect;
  // z shares x's scale per MediaPipe's own docs. Including it is what makes the
  // distance estimate survive head YAW: turning to look at the corner of the
  // screen foreshortens the eye span in the image plane by cos(yaw), and
  // without the z term that reads as "the user moved 30 cm further away".
  const dz = Number.isFinite(a.z) && Number.isFinite(b.z) ? b.z - a.z : 0;

  const span = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(span > MIN_SPAN)) return null;

  const halfTan = Math.tan((cameraHFovDeg * Math.PI) / 360);
  const distanceRaw = biocularWidthM / (2 * span * halfTan);
  const distanceMeters = Math.min(Math.max(distanceRaw, MIN_DISTANCE_M), MAX_DISTANCE_M);

  const imageX = (a.x + b.x) / 2;
  const imageY = (a.y + b.y) / 2;

  // Image NDC, +x towards the camera's right and +y downwards.
  const ndcX = 2 * imageX - 1;
  const ndcY = 2 * imageY - 1;

  // Both signs are negated on purpose. The camera faces the user, so the
  // camera's right is the user's LEFT — step to your right and you slide
  // towards x = 0 in the raw frame. And image y grows downwards. The output
  // frame is the one the viewer thinks in: +x to the user's right, +y up.
  const xMeters = -ndcX * distanceMeters * halfTan;
  const yMeters = (-ndcY * distanceMeters * halfTan) / aspect;

  return { imageX, imageY, xMeters, yMeters, distanceMeters, span };
};
