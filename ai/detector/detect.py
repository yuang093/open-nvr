import os
import cv2
import sys
import argparse
import json

# add path
#realpath = os.path.abspath(__file__)
#_sep = os.path.sep
#realpath = realpath.split(_sep)
#sys.path.append(os.path.join(realpath[0]+_sep, *realpath[1:realpath.index('rknn_model_zoo')+1]))

from py_utils.coco_utils import COCO_test_helper
import numpy as np


OBJ_THRESH = 0.25
NMS_THRESH = 0.45

# The follew two param is for map test
# OBJ_THRESH = 0.001
# NMS_THRESH = 0.65

IMG_SIZE = (640, 640)  # (width, height), such as (1280, 736)
# IMG_SIZE = (2560, 1920)
#IMG_SIZE = (1280, 1280)

CLASSES = ("person", "bicycle", "car","motorbike ","aeroplane ","bus ","train","truck ","boat","traffic light",
           "fire hydrant","stop sign ","parking meter","bench","bird","cat","dog ","horse ","sheep","cow","elephant",
           "bear","zebra ","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite",
           "baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife ",
           "spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza ","donut","cake","chair","sofa",
           "pottedplant","bed","diningtable","toilet ","tvmonitor","laptop	","mouse	","remote ","keyboard ","cell phone","microwave ",
           "oven ","toaster","sink","refrigerator ","book","clock","vase","scissors ","teddy bear ","hair drier", "toothbrush ")

coco_id_list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 34,
         35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
         64, 65, 67, 70, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 84, 85, 86, 87, 88, 89, 90]


def nms_boxes(boxes, scores):
    """Suppress non-maximal boxes.
    # Returns
        keep: ndarray, index of effective boxes.
    """
    x = boxes[:, 0]
    y = boxes[:, 1]
    w = boxes[:, 2] - boxes[:, 0]
    h = boxes[:, 3] - boxes[:, 1]

    areas = w * h
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)

        xx1 = np.maximum(x[i], x[order[1:]])
        yy1 = np.maximum(y[i], y[order[1:]])
        xx2 = np.minimum(x[i] + w[i], x[order[1:]] + w[order[1:]])
        yy2 = np.minimum(y[i] + h[i], y[order[1:]] + h[order[1:]])

        w1 = np.maximum(0.0, xx2 - xx1 + 0.00001)
        h1 = np.maximum(0.0, yy2 - yy1 + 0.00001)
        inter = w1 * h1

        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        inds = np.where(ovr <= NMS_THRESH)[0]
        order = order[inds + 1]
    keep = np.array(keep)
    return keep

def post_process(input_data):
    # YOLO11 ONNX output shape: (1, 84, 8400)
    # 84 = 4 (xywh box coords) + 80 (class scores)
    # 8400 = anchor points (80*80 + 40*40 + 20*20)
    
    output = input_data[0]  # (1, 84, 8400)
    predictions = output[0].T  # (8400, 84) - transpose to get predictions per anchor
    
    # Split into boxes and class scores
    boxes_xywh = predictions[:, :4]  # (8400, 4) - center_x, center_y, width, height
    class_scores = predictions[:, 4:]  # (8400, 80) - class probabilities
    
    # Get max class score and class index for each prediction
    class_max_scores = np.max(class_scores, axis=1)  # (8400,)
    class_ids = np.argmax(class_scores, axis=1)  # (8400,)
    
    # Filter by confidence threshold
    mask = class_max_scores >= OBJ_THRESH
    boxes_xywh = boxes_xywh[mask]
    class_max_scores = class_max_scores[mask]
    class_ids = class_ids[mask]
    
    if len(boxes_xywh) == 0:
        return None, None, None
    
    # Convert from xywh (center format) to xyxy (corner format)
    boxes_xyxy = np.zeros_like(boxes_xywh)
    boxes_xyxy[:, 0] = boxes_xywh[:, 0] - boxes_xywh[:, 2] / 2  # x1 = center_x - width/2
    boxes_xyxy[:, 1] = boxes_xywh[:, 1] - boxes_xywh[:, 3] / 2  # y1 = center_y - height/2
    boxes_xyxy[:, 2] = boxes_xywh[:, 0] + boxes_xywh[:, 2] / 2  # x2 = center_x + width/2
    boxes_xyxy[:, 3] = boxes_xywh[:, 1] + boxes_xywh[:, 3] / 2  # y2 = center_y + height/2
    
    # Apply NMS per class
    nboxes, nclasses, nscores = [], [], []
    for c in set(class_ids):
        inds = np.where(class_ids == c)[0]
        b = boxes_xyxy[inds]
        s = class_max_scores[inds]
        keep = nms_boxes(b, s)
        
        if len(keep) != 0:
            nboxes.append(b[keep])
            nclasses.append(np.full(len(keep), c))
            nscores.append(s[keep])
    
    if not nboxes:
        return None, None, None
    
    boxes = np.concatenate(nboxes)
    classes = np.concatenate(nclasses)
    scores = np.concatenate(nscores)
    
    return boxes, classes, scores


# BGR color map per COCO class id. Mirrors the frontend getColor() in VideoPlayer.jsx.
_DRAW_COLORS = {
    0: (0, 255, 0),       # person -> green
    1: (255, 204, 0),     # bicycle -> cyan
    2: (255, 136, 0),     # car -> blue
    3: (255, 200, 100),   # motorbike -> light blue
    4: (68, 68, 255),     # aeroplane -> red
    5: (200, 80, 0),      # bus -> dark blue
    6: (255, 68, 170),    # train -> purple
    7: (0, 136, 255),     # truck -> orange
    8: (230, 180, 40),    # boat -> sky blue
    14: (0, 255, 255),    # bird -> yellow
    15: (255, 0, 255),    # cat -> magenta
    16: (180, 80, 255),   # dog -> pink
    17: (30, 80, 160),    # horse -> brown
    18: (170, 170, 170),  # sheep -> grey
    19: (50, 80, 130),    # cow -> dark brown
}
_DRAW_FONT_SCALE = 0.7  # ~16px on 1920x1080 (smaller than live SVG 32px so it doesn't dominate the jpg viewer)
_DRAW_FONT_THICKNESS = 2
_DRAW_BOX_THICKNESS = 4

# Draw outlined text (white fill + black outline) for readability on any background.
def _put_text_outlined(img, text, org, scale, color_fill, color_outline=(0, 0, 0)):
    # Draw black outline first (4 directions)
    for dx, dy in [(-2, 0), (2, 0), (0, -2), (0, 2)]:
        cv2.putText(img, text, (org[0] + dx, org[1] + dy),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, color_outline,
                    _DRAW_FONT_THICKNESS + 2, cv2.LINE_AA)
    # Draw white fill on top
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color_fill,
                _DRAW_FONT_THICKNESS, cv2.LINE_AA)


def draw(image, boxes, scores, classes):
    img_h, img_w = image.shape[:2]
    for box, score, cl in zip(boxes, scores, classes):
        left, top, right, bottom = [int(_b) for _b in box]

        # Clip coordinates to image boundaries for drawing (allow slight overflow)
        left = max(0, left)
        top = max(0, top)
        right = min(img_w, right)
        bottom = min(img_h, bottom)

        # Skip invalid boxes (empty after clipping)
        if right <= left or bottom <= top:
            continue

        color = _DRAW_COLORS.get(int(cl), (0, 255, 255))  # default yellow
        # Bbox outline with black border + color center for contrast
        cv2.rectangle(image, (left, top), (right, bottom), (0, 0, 0), _DRAW_BOX_THICKNESS + 2)
        cv2.rectangle(image, (left, top), (right, bottom), color, _DRAW_BOX_THICKNESS)
        # Label = class name (strip trailing space) + percentage
        label = '{0} {1:.0f}%'.format(CLASSES[cl].strip(), score * 100)
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX,
                                              _DRAW_FONT_SCALE, _DRAW_FONT_THICKNESS)
        label_y = max(top - 10, th + baseline + 4)
        # Label background: black border + colored fill
        bg_x1, bg_y1 = left - 2, label_y - th - baseline - 4
        bg_x2, bg_y2 = left + tw + 4, label_y + baseline // 2 + 2
        cv2.rectangle(image, (bg_x1, bg_y1), (bg_x2, bg_y2), (0, 0, 0), -1)
        cv2.rectangle(image, (bg_x1 + 2, bg_y1 + 2), (bg_x2 - 2, bg_y2 - 2), color, -1)
        # Outlined text (white fill + black outline) for readability
        _put_text_outlined(image, label, (left, label_y),
                           _DRAW_FONT_SCALE, (255, 255, 255), (0, 0, 0))


def setup_model(args):
    model_path = args.model_path
    if model_path.endswith('.pt') or model_path.endswith('.torchscript'):
        platform = 'pytorch'
        from py_utils.pytorch_executor import Torch_model_container
        model = Torch_model_container(args.model_path)
    elif model_path.endswith('.rknn'):
        platform = 'rknn'
        from py_utils.rknn_executor import RKNN_model_container 
        model = RKNN_model_container(args.model_path, args.target, args.device_id)
    elif model_path.endswith('onnx'):
        platform = 'onnx'
        from py_utils.onnx_executor import ONNX_model_container
        model = ONNX_model_container(args.model_path)
    else:
        assert False, "{} is not rknn/pytorch/onnx model".format(model_path)
    #print('Model-{} is {} model, starting val'.format(model_path, platform))
    return model, platform

def img_check(path):
    img_type = ['.jpg', '.jpeg', '.png', '.bmp']
    for _type in img_type:
        if path.endswith(_type) or path.endswith(_type.upper()):
            return True
    return False

def main():
    """Main entry point for the detector package"""
    parser = argparse.ArgumentParser(description='Process some integers.')
    # basic params
    parser.add_argument('--model_path', type=str, required= True, help='model path, could be .pt or .rknn file')
    parser.add_argument('--target', type=str, default='rk3566', help='target RKNPU platform')
    parser.add_argument('--device_id', type=str, default=None, help='device id')
    
    parser.add_argument('--img_show', action='store_true', default=False, help='draw the result and show')
    parser.add_argument('--img_save', action='store_true', default=False, help='save the result')

    # data params
    parser.add_argument('--anno_json', type=str, default='../../../datasets/COCO/annotations/instances_val2017.json', help='coco annotation path')
    parser.add_argument('--coco_map_test', action='store_true', help='enable coco map test')

    # class filter
    # CSV of COCO class ids to keep. "OTHER" = keep all classes with id >= 9.
    # Empty / omitted = no filtering (run all 80 classes, current behavior).
    # Example: "0,1,2,3,4,5,7,8" = drop train, keep "其他" off.
    parser.add_argument('--enabled-classes', type=str, default='',
                        help='CSV of COCO class ids to keep. "OTHER" = keep id>=9. Empty = no filter.')

    args = parser.parse_args()

    # init model
    model, platform = setup_model(args)

    co_helper = COCO_test_helper(enable_letter_box=True)
    print('[detect] letter_box enabled', flush=True)

    # Per-frame class filter. The server may send a JSON object per line:
    #   {"image": "/abs/path.jpg", "enabledClasses": "0,1,2,3,4,5,7,8,OTHER"}
    # The legacy wire format (a bare image path on each line) is also accepted
    # for backward compatibility and means "no filter".
    def _parse_enabled_classes(csv_text):
        if not csv_text:
            return None, False
        ids = set()
        keep_others = False
        for tok in csv_text.split(','):
            tok = tok.strip()
            if not tok:
                continue
            if tok.upper() == 'OTHER':
                keep_others = True
            else:
                try:
                    ids.add(int(tok))
                except ValueError:
                    print(f'[class-filter] WARN: ignoring non-numeric token {tok!r}', flush=True)
        if not ids and not keep_others:
            # All toggles off -> detection will always be empty for this frame.
            return set(), False
        return ids, keep_others

    # Default (used when the input line is a bare path with no filter info)
    enabled_class_set = None
    enabled_keep_others = False

    # run test
    img_counter = 0
    try:
        for line in sys.stdin:
            line = line.rstrip('\n').rstrip('\r')
            if not line:
                continue

            # Parse stdin line. Newer server sends a JSON object with
            #   { "image": "...", "enabledClasses": "0,1,2,..." }
            # Older server (and manual testing) sends a bare image path.
            try:
                obj = json.loads(line)
                img_path = obj.get('image') or obj.get('path') or ''
                csv = obj.get('enabledClasses') or obj.get('enabled_classes') or ''
                if csv or obj.get('image'):
                    enabled_class_set, enabled_keep_others = _parse_enabled_classes(csv)
            except (ValueError, AttributeError):
                img_path = line.strip()
                # leave enabled_class_set from the previous frame

            if not img_path:
                continue

            img_name = os.path.basename(img_path)
            img_counter += 1

            if not os.path.exists(img_path):
                # File doesn't exist - still send a response so the server doesn't hang
                result = {
                    "image": img_path,
                    "detections": [],
                    "error": "File not found"
                }
                print(json.dumps(result))
                sys.stdout.flush()
                continue

            img_src = cv2.imread(img_path)
            if img_src is None:
                # Failed to read image - still send a response
                result = {
                    "image": img_path,
                    "detections": [],
                    "error": "Failed to read image"
                }
                print(json.dumps(result))
                sys.stdout.flush()
                continue

            # Save original image dimensions; letterbox to IMG_SIZE for the model
            orig_h, orig_w = img_src.shape[:2]
            img_rgb = cv2.cvtColor(img_src, cv2.COLOR_BGR2RGB)
            img_lb = co_helper.letter_box(img_rgb, IMG_SIZE, pad_color=(0,0,0))
            img_h, img_w = img_lb.shape[:2]  # letterboxed shape (used for input_data only)

            if platform in ['pytorch', 'onnx']:
                input_data = img_lb.transpose((2,0,1))
                input_data = input_data.reshape(1,*input_data.shape).astype(np.float32)
                input_data = input_data/255.
            else:
                input_data = img

            outputs = model.run([input_data])

            boxes, classes, scores = post_process(outputs)

            # Apply class filter if enabled. Drop boxes whose class is not
            # in the user-selected set. We do this after NMS so we still
            # benefit from per-class suppression, but before drawing so the
            # annotated image and the returned detections stay consistent.
            if enabled_class_set is not None and boxes is not None and len(boxes) > 0:
                keep_mask = np.array([
                    (int(c) in enabled_class_set) or (int(c) >= 9 and enabled_keep_others)
                    for c in classes
                ])
                if not keep_mask.all():
                    dropped = int((~keep_mask).sum())
                    if dropped:
                        print(f'[class-filter] dropped {dropped} box(es) outside enabled set', flush=True)
                    boxes = boxes[keep_mask]
                    classes = classes[keep_mask]
                    scores = scores[keep_mask]

            # Prepare detection output (even if empty)
            detections = []

            # Handle case where objects are detected
            # Map boxes from letterboxed 640x640 back to original image coordinates
            if boxes is not None and len(boxes) > 0:
                boxes = co_helper.get_real_box(boxes, in_format='xyxy')
            # Use original dimensions for clipping
            if boxes is not None and len(boxes) > 0:
                boxes[:, 0] = np.clip(boxes[:, 0], 0, orig_w)  # left
                boxes[:, 1] = np.clip(boxes[:, 1], 0, orig_h)  # top
                boxes[:, 2] = np.clip(boxes[:, 2], 0, orig_w)  # right
                boxes[:, 3] = np.clip(boxes[:, 3], 0, orig_h)  # bottom
                
                # Draw boxes on the original image
                img_annotated = img_src.copy()
                draw(img_annotated, boxes, scores, classes)
                # Overwrite the original image with annotated version
                cv2.imwrite(img_path, img_annotated)
                
                # Build detections list
                for box, score, cl in zip(boxes, scores, classes):
                    left, top, right, bottom = [int(_b) for _b in box]
                    detections.append({
                        "object": CLASSES[cl],
                        "box": [left, top, right, bottom],
                        "probability": float(score)
                    })
            
            # Always output JSON result (even with empty detections)
            result = {
                "image": img_path,
                "detections": detections
            }
            print(json.dumps(result))
            sys.stdout.flush()  # Ensure output is sent immediately
            
            if args.img_show or args.img_save:
                print('\n\nIMG: {}'.format(img_name))
                img_p = img_src.copy()
                if boxes is not None:
                    print("Image shape:", img_src.shape)
                    print("Detected boxes:", boxes[:5] if len(boxes) > 5 else boxes)
                    # No need to map boxes - they're already in correct coordinates
                    draw(img_p, boxes, scores, classes)

                if args.img_save:
                    if not os.path.exists('./result'):
                        os.mkdir('./result')
                    result_path = os.path.join('./result', img_name)
                    cv2.imwrite(result_path, img_p)
                    print('Detection result save to {}'.format(result_path))
                            
                if args.img_show:
                    cv2.imshow("full post process result", img_p)
                    cv2.waitKeyEx(0)
    
    except KeyboardInterrupt:
        print("\nExiting gracefully...")
    except EOFError:
        print("\nEnd of input reached.")
    finally:
        model.release()
        # cv2.destroyAllWindows()  # Disabled for headless (libgtk2 not installed)

if __name__ == '__main__':
    main()
