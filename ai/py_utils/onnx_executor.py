import os
import numpy as np
import onnxruntime as rt

type_map = {
    'tensor(int32)': np.int32,
    'tensor(int64)': np.int64,
    'tensor(float32)': np.float32,
    'tensor(float64)': np.float64,
    'tensor(float)': np.float32,
    'tensor(bool)': np.bool_,
}


def ignore_dim_with_zero(_shape, _shape_target):
    # Filter size=1 dims from data, and size=1 + symbolic (str/None) dims from target
    _shape = [d for d in _shape if d != 1]
    _shape_target = [d for d in _shape_target if d != 1 and not isinstance(d, str) and d is not None]
    if len(_shape) != len(_shape_target):
        return False
    return all(a == b for a, b in zip(_shape, _shape_target))


class ONNX_model_container_py:
    def __init__(self, model_path):
        sp_options = rt.SessionOptions()
        sp_options.log_severity_level = 3
        self.sess = rt.InferenceSession(model_path, sess_options=sp_options, providers=['CPUExecutionProvider'])
        self.model_path = model_path

    def run(self, input_datas):
        if self.sess is None:
            print("ERROR: sess has been released")
            return []

        if len(input_datas) < len(self.sess.get_inputs()):
            assert False, 'inputs_datas number not match onnx model{} input'.format(self.model_path)
        elif len(input_datas) > len(self.sess.get_inputs()):
            print('WARNING: input datas number large than onnx input node')

        input_dict = {}
        for i, _input in enumerate(self.sess.get_inputs()):
            # convert type
            if _input.type in type_map and type_map[_input.type] != input_datas[i].dtype:
                print('WARNING: force data-{} from {} to {}'.format(i, input_datas[i].dtype, type_map[_input.type]))
                input_datas[i] = input_datas[i].astype(type_map[_input.type])

            # Convert symbolic dim names to actual data dims
            model_shape = list(_input.shape)
            data_shape = list(input_datas[i].shape)
            if len(model_shape) == len(data_shape):
                # Substitute symbolic dims with data dims
                actual_shape = []
                skip_reshape = True
                for idx in range(len(model_shape)):
                    dim = model_shape[idx]
                    if isinstance(dim, str) or dim is None:
                        actual_shape.append(data_shape[idx])
                    elif dim != data_shape[idx]:
                        if dim == 1:
                            actual_shape.append(data_shape[idx])
                        else:
                            skip_reshape = False
                            actual_shape.append(dim)
                    else:
                        actual_shape.append(dim)
                if not skip_reshape or tuple(actual_shape) != tuple(data_shape):
                    input_datas[i] = input_datas[i].reshape(tuple(actual_shape))
            input_dict[_input.name] = input_datas[i]

        output_list = []
        for i in range(len(self.sess.get_outputs())):
            output_list.append(self.sess.get_outputs()[i].name)

        res = self.sess.run(output_list, input_dict)
        return res

    def release(self):
        del self.sess
        self.sess = None


class ONNX_model_container_cpp:
    def __init__(self, model_path):
        pass

    def run(self, input_datas):
        pass


def ONNX_model_container(model_path, backend='py'):
    if backend == 'py':
        return ONNX_model_container_py(model_path)
    elif backend == 'cpp':
        return ONNX_model_container_cpp(model_path)


def reset_onnx_shape(onnx_model_path, output_path, input_shapes):
    if isinstance(input_shapes[0], int):
        command = "python -m onnxsim {} {} --input-shape {}".format(onnx_model_path, output_path, ','.join([str(v) for v in input_shapes]))
    else:
        if len(input_shapes) != 1:
            print("RESET ONNX SHAPE with more than one input, try to match input name")
            sess = rt.InferenceSession(onnx_model_path)
            input_names = [input.name for input in sess.get_inputs()]
            command = "python -m onnxsim {} {} --input-shape ".format(onnx_model_path, output_path)
            for i, input_name in enumerate(input_names):
                command += "{}:{} ".format(input_name, ','.join([str(v) for v in input_shapes[i]]))
        else:
            command = "python -m onnxsim {} {} --input-shape {}".format(onnx_model_path, output_path, ','.join([str(v) for v in input_shapes[0]]))

    print(command)
    os.system(command)
    return output_path
