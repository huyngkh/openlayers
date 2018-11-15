/**
 * @module ol/webgl/Helper
 */
import {getUid} from '../util.js';
import {EXTENSIONS as WEBGL_EXTENSIONS} from '../webgl.js';
import Disposable from '../Disposable.js';
import {includes} from '../array.js';
import {listen, unlistenAll} from '../events.js';
import {clear} from '../obj.js';
import {ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, TEXTURE_2D, TEXTURE_WRAP_S, TEXTURE_WRAP_T} from '../webgl.js';
import ContextEventType from '../webgl/ContextEventType.js';
import {
  create as createTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform
} from "../transform";
import {create, fromTransform} from "../vec/mat4";
import WebGLBuffer from "./Buffer";
import WebGLVertex from "./Vertex";
import WebGLFragment from "./Fragment";
import WebGLPostProcessingPass from "./PostProcessingPass";


/**
 * @typedef {Object} BufferCacheEntry
 * @property {import("./Buffer.js").default} buf
 * @property {WebGLBuffer} buffer
 */

export const DefaultUniform = {
  PROJECTION_MATRIX: 'u_projectionMatrix',
  OFFSET_SCALE_MATRIX: 'u_offsetScaleMatrix',
  OFFSET_ROTATION_MATRIX: 'u_offsetRotateMatrix',
  OPACITY: 'u_opacity'
};

export const DefaultAttrib = {
  POSITION: 'a_position',
  TEX_COORD: 'a_texCoord',
  OPACITY: 'a_opacity',
  ROTATE_WITH_VIEW: 'a_rotateWithView',
  OFFSETS: 'a_offsets'
};

/**
 * @classdesc
 * A WebGL context for accessing low-level WebGL capabilities.
 * Will handle attributes, uniforms, buffers, textures, frame buffers.
 * The context will always render to a frame buffer in order to allow post-processing.
 */
class WebGLHelper extends Disposable {

  /**
   */
  constructor(opt_options) {
    super();
    const options = opt_options || {};

    /**
     * @private
     * @type {HTMLCanvasElement}
     */
    this.canvas_ = document.createElement('canvas');
    this.canvas_.style.position = 'absolute';


    /**
     * @private
     * @type {WebGLRenderingContext}
     */
    this.gl_ = this.canvas_.getContext('webgl');

    /**
     * @private
     * @type {!Object<string, BufferCacheEntry>}
     */
    this.bufferCache_ = {};

    /**
     * @private
     * @type {!Object<string, WebGLShader>}
     */
    this.shaderCache_ = {};

    /**
     * @private
     * @type {!Object<string, WebGLProgram>}
     */
    this.programCache_ = {};

    /**
     * @private
     * @type {WebGLProgram}
     */
    this.currentProgram_ = null;

    /**
     * @type {boolean}
     */
    this.hasOESElementIndexUint = includes(WEBGL_EXTENSIONS, 'OES_element_index_uint');

    // use the OES_element_index_uint extension if available
    if (this.hasOESElementIndexUint) {
      this.gl_.getExtension('OES_element_index_uint');
    }

    listen(this.canvas_, ContextEventType.LOST,
      this.handleWebGLContextLost, this);
    listen(this.canvas_, ContextEventType.RESTORED,
      this.handleWebGLContextRestored, this);

    /**
     * @private
     * @type {import("../transform.js").Transform}
     */
    this.projectionMatrix_ = createTransform();

    /**
     * @private
     * @type {import("../transform.js").Transform}
     */
    this.offsetRotateMatrix_ = createTransform();

    /**
     * @private
     * @type {import("../transform.js").Transform}
     */
    this.offsetScaleMatrix_ = createTransform();

    /**
     * @private
     * @type {Array<number>}
     */
    this.tmpMat4_ = create();

    /**
     * @private
     * @type {Object.<string, WebGLUniformLocation>}
     */
    this.uniformLocations_;

    /**
     * @private
     * @type {Object.<string, number>}
     */
    this.attribLocations_;

    /**
     * Holds info about custom uniforms used in the post processing pass
     * @type {Array<{value: *, texture?: WebGLTexture}>}
     * @private
     */
    this.uniforms_ = [];
    options.uniforms && Object.keys(options.uniforms).forEach(function(name) {
      this.uniforms_.push({
        name: name,
        value: options.uniforms[name]
      });
    }.bind(this));

    // initialize post processes from options
    // if none given, use a default one
    const gl = this.getGL();
    this.postProcessPasses = options.postProcesses ? options.postProcesses.map(function(options) {
      return new WebGLPostProcessingPass({
        webGlContext: gl,
        scaleRatio: options.scaleRatio,
        vertexShader: options.vertexShader,
        fragmentShader: options.fragmentShader,
        uniforms: options.uniforms
      });
    }) : [new WebGLPostProcessingPass({ webGlContext: gl })];
  }

  /**
   * Just bind the buffer if it's in the cache. Otherwise create
   * the WebGL buffer, bind it, populate it, and add an entry to
   * the cache.
   * TODO: improve this, the logic is unclear: we want A/ to bind a buffer and B/ to flush data in it
   * @param {number} target Target.
   * @param {WebGLBuffer} buf Buffer.
   */
  bindBuffer(target, buf) {
    const gl = this.getGL();
    const arr = buf.getArray();
    const bufferKey = getUid(buf);
    let bufferCache = this.bufferCache_[bufferKey];
    if (!bufferCache) {
      const buffer = gl.createBuffer();
      bufferCache = this.bufferCache_[bufferKey] = {
        buf: buf,
        buffer: buffer
      };
    }
    gl.bindBuffer(target, bufferCache.buffer);
    let /** @type {ArrayBufferView} */ arrayBuffer;
    if (target == ARRAY_BUFFER) {
      arrayBuffer = new Float32Array(arr);
    } else if (target == ELEMENT_ARRAY_BUFFER) {
      arrayBuffer = this.hasOESElementIndexUint ?
        new Uint32Array(arr) : new Uint16Array(arr);
    }
    gl.bufferData(target, arrayBuffer, buf.getUsage());
  }

  /**
   * @param {import("./Buffer.js").default} buf Buffer.
   */
  deleteBuffer(buf) {
    const gl = this.getGL();
    const bufferKey = getUid(buf);
    const bufferCacheEntry = this.bufferCache_[bufferKey];
    if (!gl.isContextLost()) {
      gl.deleteBuffer(bufferCacheEntry.buffer);
    }
    delete this.bufferCache_[bufferKey];
  }

  /**
   * @inheritDoc
   */
  disposeInternal() {
    unlistenAll(this.canvas_);
    const gl = this.getGL();
    if (!gl.isContextLost()) {
      for (const key in this.bufferCache_) {
        gl.deleteBuffer(this.bufferCache_[key].buffer);
      }
      for (const key in this.programCache_) {
        gl.deleteProgram(this.programCache_[key]);
      }
      for (const key in this.shaderCache_) {
        gl.deleteShader(this.shaderCache_[key]);
      }
    }
  }

  /**
   * Clear the buffer & set the viewport to draw
   */
  prepareDraw(size, pixelRatio) {
    const gl = this.getGL();
    const canvas = this.getCanvas();

    canvas.width = size[0] * pixelRatio;
    canvas.height = size[1] * pixelRatio;
    canvas.style.width = size[0] + 'px';
    canvas.style.height = size[1] + 'px';

    gl.useProgram(this.currentProgram_);

    // loop backwards in post processes list
    for (let i = this.postProcessPasses.length - 1; i >= 0; i--) {
      this.postProcessPasses[i].init(size, pixelRatio);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.applyUniforms();
  }

  /**
   * @protected
   * @param {number} start Start index.
   * @param {number} end End index.
   */
  drawElements(start, end) {
    const gl = this.getGL();
    const elementType = this.hasOESElementIndexUint ?
      gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const elementSize = this.hasOESElementIndexUint ? 4 : 2;

    const numItems = end - start;
    const offsetInBytes = start * elementSize;
    gl.drawElements(gl.TRIANGLES, numItems, elementType, offsetInBytes);
  }

  /**
   * Copy the frame buffer to the canvas
   */
  finalizeDraw() {
    // apply post processes using the next one as target
    for (let i = 0; i < this.postProcessPasses.length; i++) {
      this.postProcessPasses[i].apply(this.postProcessPasses[i + 1] || null);
    }
  }

  /**
   * @return {HTMLCanvasElement} Canvas.
   */
  getCanvas() {
    return this.canvas_;
  }

  /**
   * Get the WebGL rendering context
   * @return {WebGLRenderingContext} The rendering context.
   * @api
   */
  getGL() {
    return this.gl_;
  }

  /**
   * Sets the matrices uniforms for a given frame state
   * @param {import("../PluggableMap.js").FrameState} frameState Frame state.
   */
  applyFrameState(frameState) {
    const size = frameState.size;
    const rotation = frameState.viewState.rotation;
    const resolution = frameState.viewState.resolution;
    const center = frameState.viewState.center;

    // set the "uniform" values (coordinates 0,0 are the center of the view)
    const projectionMatrix = resetTransform(this.projectionMatrix_);
    scaleTransform(projectionMatrix, 2 / (resolution * size[0]), 2 / (resolution * size[1]));
    rotateTransform(projectionMatrix, -rotation);
    translateTransform(projectionMatrix, -center[0], -center[1]);

    const offsetScaleMatrix = resetTransform(this.offsetScaleMatrix_);
    scaleTransform(offsetScaleMatrix, 2 / size[0], 2 / size[1]);

    const offsetRotateMatrix = resetTransform(this.offsetRotateMatrix_);
    if (rotation !== 0) {
      rotateTransform(offsetRotateMatrix, -rotation);
    }

    this.setUniformMatrixValue(DefaultUniform.PROJECTION_MATRIX, fromTransform(this.tmpMat4_, projectionMatrix));
    this.setUniformMatrixValue(DefaultUniform.OFFSET_SCALE_MATRIX, fromTransform(this.tmpMat4_, offsetScaleMatrix));
    this.setUniformMatrixValue(DefaultUniform.OFFSET_ROTATION_MATRIX, fromTransform(this.tmpMat4_, offsetRotateMatrix));
  }

  /**
   * Get shader from the cache if it's in the cache. Otherwise, create
   * the WebGL shader, compile it, and add entry to cache.
   * @param {import("./Shader.js").default} shaderObject Shader object.
   * @return {WebGLShader} Shader.
   */
  getShader(shaderObject) {
    const shaderKey = getUid(shaderObject);
    if (shaderKey in this.shaderCache_) {
      return this.shaderCache_[shaderKey];
    } else {
      const gl = this.getGL();
      const shader = gl.createShader(shaderObject.getType());
      gl.shaderSource(shader, shaderObject.getSource());
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(`Shader compilation failed - log:\n${gl.getShaderInfoLog(shader)}`);
      }
      this.shaderCache_[shaderKey] = shader;
      return shader;
    }
  }

  /**
   * Use a program.  If the program is already in use, this will return `false`.
   * @param {WebGLProgram} program Program.
   * @return {boolean} Changed.
   * @api
   */
  useProgram(program) {
    if (program == this.currentProgram_) {
      return false;
    } else {
      const gl = this.getGL();
      gl.useProgram(program);
      this.currentProgram_ = program;
      this.uniformLocations_ = {};
      this.attribLocations_ = {};
      return true;
    }
  }

  /**
   * Get the program from the cache if it's in the cache. Otherwise create
   * the WebGL program, attach the shaders to it, and add an entry to the
   * cache.
   * @param {import("./Fragment.js").default} fragmentShaderObject Fragment shader.
   * @param {import("./Vertex.js").default} vertexShaderObject Vertex shader.
   * @return {WebGLProgram} Program.
   */
  getProgram(fragmentShaderObject, vertexShaderObject) {
    const programKey = getUid(fragmentShaderObject) + '/' + getUid(vertexShaderObject);
    if (programKey in this.programCache_) {
      return this.programCache_[programKey];
    } else {
      const gl = this.getGL();
      const program = gl.createProgram();
      gl.attachShader(program, this.getShader(fragmentShaderObject));
      gl.attachShader(program, this.getShader(vertexShaderObject));
      gl.linkProgram(program);
      this.programCache_[programKey] = program;
      return program;
    }
  }

  /**
   * Will get the location from the shader or the cache
   * @param {string} name Uniform name
   * @return {WebGLUniformLocation} uniformLocation
   */
  getUniformLocation(name) {
    if (!this.uniformLocations_[name]) {
      this.uniformLocations_[name] = this.getGL().getUniformLocation(this.currentProgram_, name);
    }
    return this.uniformLocations_[name];
  }

  /**
   * Will get the location from the shader or the cache
   * @param {string} name Attribute name
   * @return {number} attribLocation
   */
  getAttributeLocation(name) {
    if (!this.attribLocations_[name]) {
      this.attribLocations_[name] = this.getGL().getAttribLocation(this.currentProgram_, name);
    }
    return this.attribLocations_[name];
  }

  /**
   * Give a value for a standard float uniform
   * @param {string} uniform Uniform name
   * @param {number} value Value
   */
  setUniformFloatValue(uniform, value) {
    this.getGL().uniform1f(this.getUniformLocation(uniform), value);
  }

  /**
   * Give a value for a standard matrix4 uniform
   * @param {string} uniform Uniform name
   * @param {Array<number>} value Matrix value
   */
  setUniformMatrixValue(uniform, value) {
    this.getGL().uniformMatrix4fv(this.getUniformLocation(uniform), false, value);
  }

  /**
   * Will set the currently bound buffer to an attribute of the shader program
   * @param {string} attribName
   * @param {number} size Number of components per attributes
   * @param {number} type UNSIGNED_INT, UNSIGNED_BYTE, UNSIGNED_SHORT or FLOAT
   * @param {number} stride Stride in bytes (0 means attribs are packed)
   * @param {number} offset Offset in bytes
   */
  enableAttributeArray(attribName, size, type, stride, offset) {
    this.getGL().enableVertexAttribArray(this.getAttributeLocation(attribName));
    this.getGL().vertexAttribPointer(this.getAttributeLocation(attribName), size, type,
      false, stride, offset);
  }

  /**
   * FIXME empty description for jsdoc
   */
  handleWebGLContextLost() {
    clear(this.bufferCache_);
    clear(this.shaderCache_);
    clear(this.programCache_);
    this.currentProgram_ = null;
  }

  /**
   * FIXME empty description for jsdoc
   */
  handleWebGLContextRestored() {
  }

  // TODO: shutdown program

  // todo
  applyUniforms() {
    const gl = this.getGL();

    let value;
    let textureSlot = 0;
    this.uniforms_.forEach(function(uniform) {
      value = typeof uniform.value === 'function' ? uniform.value() : uniform.value;

      // apply value based on type
      if (value instanceof HTMLCanvasElement || value instanceof ImageData) {
        // create a texture & put data
        if (!uniform.texture) {
          uniform.texture = gl.createTexture();
        }
        gl.activeTexture(gl[`TEXTURE${textureSlot}`]);
        gl.bindTexture(gl.TEXTURE_2D, uniform.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        if (value instanceof ImageData) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, value.width, value.height, 0,
            gl.UNSIGNED_BYTE, new Uint8Array(value.data));
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, value);
        }

        // fill texture slots
        gl.uniform1i(this.getUniformLocation(uniform.name), textureSlot++);

      } else if (Array.isArray(value)) {
        switch (value.length) {
          case 2:
            gl.uniform2f(this.getUniformLocation(uniform.name), value[0], value[1]);
            return;
          case 3:
            gl.uniform3f(this.getUniformLocation(uniform.name), value[0], value[1], value[2]);
            return;
          case 4:
            gl.uniform4f(this.getUniformLocation(uniform.name), value[0], value[1], value[2], value[3]);
            return;
        }
      } else if (typeof value === 'number') {
        gl.uniform1f(this.getUniformLocation(uniform.name), value);
      }
    }.bind(this));
  }

  /**
   * @param {number=} opt_wrapS wrapS.
   * @param {number=} opt_wrapT wrapT.
   * @return {WebGLTexture} The texture.
   */
  createTextureInternal(opt_wrapS, opt_wrapT) {
    const gl = this.getGL();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    if (opt_wrapS !== undefined) {
      gl.texParameteri(
        TEXTURE_2D, TEXTURE_WRAP_S, opt_wrapS);
    }
    if (opt_wrapT !== undefined) {
      gl.texParameteri(
        TEXTURE_2D, TEXTURE_WRAP_T, opt_wrapT);
    }

    return texture;
  }

  /**
   * @param {number} width Width.
   * @param {number} height Height.
   * @param {number=} opt_wrapS wrapS.
   * @param {number=} opt_wrapT wrapT.
   * @return {WebGLTexture} The texture.
   */
  createEmptyTexture(width, height, opt_wrapS, opt_wrapT) {
    const gl = this.getGL();
    const texture = this.createTextureInternal( opt_wrapS, opt_wrapT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return texture;
  }


  /**
   * @param {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} image Image.
   * @param {number=} opt_wrapS wrapS.
   * @param {number=} opt_wrapT wrapT.
   * @return {WebGLTexture} The texture.
   */
  createTexture(image, opt_wrapS, opt_wrapT) {
    const gl = this.getGL();
    const texture = this.createTextureInternal(opt_wrapS, opt_wrapT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return texture;
  }
}

export default WebGLHelper;
