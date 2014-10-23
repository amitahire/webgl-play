var Model = require('./model');
var math = require('../math/math');
var utils = require('../utils/utils');
var Texture = require('./texture');

/**
 * A basic view. A View is a collection of transform (inherited from model),
 * a projection matrix and a viewport. Note that you can use View.perspective
 * and View.orthographic to create respectively a perspective projection
 * view or a orthographic projection view. If viewport is not given (or null),
 * then the viewport will automatically track the canvas dimensions.
 *
 * Additionally, a view specifies various gl states, such as whether to enable
 * depth testing, blending and face culling (see the view's properties).
 *
 * @param ctx the context.
 * @param projection the projection matrix (math.mat4).
 * @param viewport the viewport (math.vec4).
 * @param options optional options.
 * @constructor
 */
function View(ctx, projection, viewport, options) {
    Model.call(this, ctx, options);

    this._projection = projection;
    this._projection_set = false;

    this.options = utils.merge({
        color: null,
        depth: ctx.gl.LESS,
        blend: false,
        scissor: true,
        cull: {
            face: ctx.gl.BACK,
            direction: ctx.gl.CCW
        },
        interactive: true,
        buffer: null
    }, options);

    /** The viewport, or unset to track the canvas dimensions. */
    this.viewport = viewport;

    /** The clear color, or null to disable clearing the color (defaults to null). */
    this.color = this.options.color;

    /** The depth function, or false to disable depth testing (defaults to gl.LESS). */
    this.depth = this.options.depth;

    /** The blend function ({sfactor:, dfactor:}), or false to disable blending (defaults to false). */
    this.blend = this.options.blend;

    /** Whether to enable the scissor test matching the viewport (defaults to true). */
    this.scissor = this.options.scissor;

    /** Whether to cull faces ({face:, direction:}), or false to disable culling (defaults to {face: gl.BACK, direction: gl.CCW}). */
    this.cull = this.options.cull;

    this._buffer = null;

    this._interactive = false;
    this.interactive(ctx, this.options.interactive);

    this.originTransform = math.transform.track(math.transform.create(), this, 'transform', function(out, tr) {
        return math.transform.invert(out, tr);
    });

    this.updateViewport(ctx);
}

View.prototype = Object.create(Model.prototype);
View.prototype.constructor = View;

View.prototype.interactive = function(ctx, v) {
    if (typeof v === 'undefined') {
        return this._interactive;
    }

    if (this._interactive) {
        ctx._signals.off('event', this._on_event, this);
    }

    if (v === false) {
        this._interactive = false;
        return;
    }

    this._interactive = utils.merge({
        origin: math.vec3.create(),

        rotate: {
            scroll_sensitivity: 0.01,
            mouse_sensitivity: 0.01,
        },

        translate: {
            mouse_sensitivity: 1,
            scroll_sensitivity: 0.1
        },

        zoom: {
            mouse_sensitivity: 0.1,
            scroll_sensitivity: 0.1,
            sensitivity: 0.1
        }
    }, v === true ? {} : v);

    this._interactive._mouse_pressed = false;

    ctx._signals.on('event', this._on_event, this);

    ctx.gl.canvas.addEventListener('contextmenu', function(e) {
        e.preventDefault();
    });
}

View.prototype._rotate_dx_dy = function(dx, dy, s, origTransform) {
    if (typeof origTransform !== 'undefined') {
        math.transform.copy(this.transform, origTransform);
    }

    var lrotX = math.quat.setAxisAngle(math.quat.create(), this.transform.sideAxis(), -dy * s);

    var rot = math.quat.mul(math.quat.create(),
                            math.quat.setAxisAngle(math.quat.create(),
                                                   [0, 1, 0],
                                                   -dx * s),
                            lrotX);

    rot = math.quat.mul(rot, rot, this.transform.orientation);

    var v = math.vec3.subtract(math.vec3.create(), this.transform.position, this._interactive.origin);
    var otr = math.vec3.transformQuat(math.vec3.create(), v, math.quat.invert(math.quat.create(), this.transform.orientation));

    var tr = math.vec3.transformQuat(math.vec3.create(), otr, rot);
    math.transform.copy(this.transform, new math.transform(rot, math.vec3.add(tr, tr, this._interactive.origin)));

    //var tr = math.transform.create().rotate(rot);

    // Rotate with deltas, around origin
    //this.transform.preMul(tr);
}

View.prototype._translate_dx_dy = function(dx, dy, sx, sy, origTransform) {
    if (typeof origTransform !== 'undefined') {
        math.transform.copy(this.transform, origTransform);
    }

    this.transform.translateSide(dx * sx).translateUp(dy * sy);
}

View.prototype._zoom_dx_dy = function(dx, dy, s, origTransform) {
    if (typeof origTransform !== 'undefined') {
        math.transform.copy(this.transform, origTransform);
    }

    this.transform.translateForward((dx + dy) * s);
}

View.prototype._on_event = function(ctx, e) {
    switch (e.type) {
    case 'wheel':
        if (e.shiftKey) {
            // Translate
            this._translate_dx_dy(e.deltaX,
                                  e.deltaY,
                                  this._interactive.translate.scroll_sensitivity,
                                  this._interactive.translate.scroll_sensitivity);
        } else if (e.ctrlKey) {
            // Zoom
            this._zoom_dx_dy(e.deltaX, e.deltaY, this._interactive.zoom.scroll_sensitivity);
        } else {
            // Rotate
            this._rotate_dx_dy(e.deltaX, e.deltaY, this._interactive.rotate.scroll_sensitivity);
        }

        e.preventDefault();
        e.stopPropagation();
        break;
    case 'mousedown':
        this._interactive._mouse_pressed = {
            x: e.offsetX,
            y: e.offsetY,
            button: e.button,
            transform: this.transform.clone(),
            translation: null
        };
        break;
    case 'mousemove':
        var mp = this._interactive._mouse_pressed;

        if (mp !== null && mp.button === 0) {
            if (e.shiftKey) {
                // Translate
                var l = math.vec3.len(math.vec3.subtract(math.vec3.create(),
                                                         mp.transform.position,
                                                         this._interactive.origin));

                var proj = this.projection();
                var vp = this.currentViewport();

                var sensitivity = this._interactive.translate.mouse_sensitivity;

                var scale = {
                    x: (2 * l) / (proj[0] * vp[2]) * sensitivity,
                    y: (2 * l) / (proj[5] * vp[3]) * sensitivity
                };

                var d = {
                    x: mp.x - e.offsetX,
                    y: e.offsetY - mp.y
                }

                this._translate_dx_dy(d.x,
                                      d.y,
                                      scale.x,
                                      scale.y,
                                      mp.transform);

                this._interactive._mouse_pressed.translation = [d.x * scale.x, d.y * scale.y, 0];
            } else if (e.ctrlKey) {
                // Zoom
                this._zoom_dx_dy(e.offsetX - mp.x,
                                 e.offsetY - mp.y,
                                 this._interactive.zoom.mouse_sensitivity,
                                 mp.transform);
            } else {
                // Rotate
                this._rotate_dx_dy(e.offsetX - mp.x,
                                   e.offsetY - mp.y,
                                   this._interactive.rotate.mouse_sensitivity,
                                   mp.transform);
            }

            e.preventDefault();
            e.stopPropagation();
        }
        break;
    case 'mouseup':
        var mp = this._interactive._mouse_pressed;

        if (mp !== null && mp.translation !== null) {
            math.vec3.add(this._interactive.origin, this._interactive.origin, mp.translation);
        }

        this._interactive._mouse_pressed = null;
        break;
    }
}

/**
 * Get the currently used viewport. If the viewport property is set, then
 * this function returns that. If not, then this function returns the automatically
 * computed viewport from the canvas.
 */
View.prototype.currentViewport = function() {
    if (this.viewport) {
        return this.viewport;
    } else {
        return this._viewport;
    }
}

View.prototype.bufferTextures = function(name) {
    return this._buffer.buffers[name];
}

View.prototype.activeBufferTexture = function(name) {
    var buf = this.bufferTextures(name);

    return buf.textures[buf.active];
}

View.prototype.cycleBufferTextures = function(ctx, names) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._buffer.fbo);

    for (var i = 0; i < names.length; i++) {
        var buffer = this._buffer.buffers[name];

        if (buffer.textures.length === 1) {
            continue;
        }

        buffer.active++;

        if (buffer.active >= buffer.textures.length) {
            buffer.active = 0;
        }

        gl.framebufferTexture2D(gl.FRAMEBUFFER,
                                buffer.attachment,
                                buffer.textureTarget,
                                buffer.textures[buffer.active].id, 0);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

View.prototype._viewportChanged = function(vp) {
    if (!this._viewport) {
        return true;
    }

    for (var i = 0; i < 4; i++) {
        if (this._viewport[i] != vp[i]) {
            return true;
        }
    }

    return false;
}

/**
 * Update the viewport of the view. This is called automatically
 * when the canvas dimensions change. When no explicit viewport is
 * set, the viewport is automatically updated to cover the canvas.
 *
 * @param ctx the context.
 */
View.prototype.updateViewport = function(ctx) {
    var gl = ctx.gl;
    var vp;

    if (!this.viewport) {
        vp = [0, 0, gl.canvas.clientWidth, gl.canvas.clientHeight];
    } else {
        vp = this.viewport;
    }

    if (!this._viewportChanged(vp)) {
        return;
    }

    this._viewport = vp

    if (this.options.buffer !== null) {
        if (this._buffer !== null) {
            for (var k in this._buffer.buffers) {
                var buffer = this._buffer.buffers[k];

                for (var i = 0; i < buffer.textures.length; i++) {
                    var texture = buffer.textures[i];

                    if (texture.target !== gl.TEXTURE_CUBE) {
                        gl.deleteTexture(texture.id);
                    }
                }
            }

            for (var i = 0; i < this._buffer.cubes.length; i++) {
                gl.deleteTexture(this._buffer.cubes[i].id);
            }

            gl.deleteFramebuffer(this._buffer.fbo);
        }

        this._buffer = {
            fbo: gl.createFramebuffer(),
            buffers: {},
            cubes: []
        };

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._buffer.fbo);

        var hasDepth = false;

        for (var k in this.options.buffer) {
            var n = this.options.buffer[k];

            var textureTarget = n.textureTarget || gl.TEXTURE_2D;
            var attachment = n.attachment || gl.COLOR_ATTACHMENT0;
            var internalFormat = n.internalFormat || gl.RGBA;
            var format = n.format || gl.RGBA;

            var textures = [];

            if (attachment === gl.DEPTH_ATTACHMENT || attachment === gl.DEPTH_STENCIL_ATTACHMENT) {
                hasDepth = true;
            }

            for (var i = 0; i < (n.n || 1); i++) {
                var texture;

                if (textureTarget !== gl.TEXTURE_2D) {
                    if (i >= this._buffer.cubes.length) {

                        texture = new Texture(ctx, gl.TEXTURE_CUBE);
                        this._buffer.cubes.push(texture);
                    } else {
                        texture = this._buffer.cubes[i];
                    }
                } else {
                    texture = new Texture(ctx);
                }

                texture.bind(ctx);

                gl.texImage2D(textureTarget,
                              0,
                              internalFormat,
                              gl.canvas.clientWidth,
                              gl.canvas.clientHeight,
                              0,
                              format,
                              n.type,
                              null);

                if (i === 0) {
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, textureTarget, texture.id, 0);
                }

                texture.unbind(ctx);
                textures.push(texture);
            }

            this._buffer.buffers[k] = {
                textures: textures,
                attachment: attachment,
                internalFormat: internalFormat,
                format: format,
                type: n.type,
                textureTarget: textureTarget,
                active: 0
            };
        }

        if (!hasDepth) {
            var rb = gl.createRenderbuffer();

            gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, gl.canvas.clientWidth, gl.canvas.clientHeight);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
        }

        var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            var msgs = {};

            msgs[gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT] = 'not all attachment points are complete';
            msgs[gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS] = 'not all attached images have the same dimensions';
            msgs[gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT] = 'no images are attached to the framebuffer';
            msgs[gl.FRAMEBUFFER_UNSUPPORTED] = 'combination of internal formats of attached images violates restrictions';

            throw new Error('Framebuffer not complete: ' + status + '(' + msgs[status] + ')');
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
}

/**
 * Get/set the projection matrix.
 *
 * @param projection the projection matrix (math.mat4) to set.
 */
View.prototype.projection = function(projection) {
    if (typeof projection !== 'undefined') {
        this._projection = projection;
        this._projection_set = true;
    } else {
        return this._projection;
    }
}

View.prototype.unbind = function(ctx) {
    var gl = ctx.gl;

    if (this._buffer) {
        for (var k in this._buffer.buffers) {
            var buffer = this._buffer.buffers[k];

            gl.framebufferTexture2D(gl.FRAMEBUFFER,
                                    buffer.attachment,
                                    buffer.textureTarget,
                                    null,
                                    0);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
}

/**
 * Binds the view to the given context. This sets the various gl
 * states corresponding to the view's settings. Note that this
 * is normally automatically called by setting the view in the
 * rendering context and should not be called by users.
 *
 * @param ctx the context.
 */
View.prototype.bind = function(ctx) {
    var c = this.color;
    var gl = ctx.gl;

    if (this._buffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._buffer.fbo);

        for (var k in this._buffer.buffers) {
            var buffer = this._buffer.buffers[k];

            gl.framebufferTexture2D(gl.FRAMEBUFFER,
                                    buffer.attachment,
                                    buffer.textureTarget,
                                    buffer.textures[buffer.active].id,
                                    0);
        }
    }

    var vp = this._viewport;
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);

    if (this.scissor) {
        gl.scissor(vp[0], vp[1], vp[2], vp[3]);
        gl.enable(gl.SCISSOR_TEST);
    } else {
        gl.disable(gl.SCISSOR_TEST);
    }

    var cbit = 0;

    if (c) {
        gl.clearColor(c[0], c[1], c[2], c[3]);
        cbit |= gl.COLOR_BUFFER_BIT;
    }

    if (this.depth !== false) {
        cbit |= gl.DEPTH_BUFFER_BIT;
        gl.enable(gl.DEPTH_TEST);

        if (this.depth !== true) {
            gl.depthFunc(this.depth);
        } else {
            gl.depthFunc(gl.LESS);
        }
    } else {
        gl.disable(gl.DEPTH_TEST);
    }

    if (this.blend) {
        gl.enable(gl.BLEND);
        gl.blendFunc(this.blend.sfactor, this.blend.dfactor);
    } else {
        gl.disable(gl.BLEND);
    }

    if (this.cull) {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(this.cull.face);
        gl.frontFace(this.cull.direction);
    } else {
        gl.disable(gl.CULL_FACE);
    }

    if (cbit !== 0) {
        gl.clear(cbit);
    }
}

View._make_perspective = function(fovy, aspect, near, far) {
    return math.mat4.perspective(math.mat4.create(), fovy / 180 * Math.PI, aspect, near, far);
}

/**
 * Create a view with a perspective projection. By default the viewport will be
 * set to track the canvas dimensions. The default viewport can be changed
 * by setting the .viewport property after construction. If aspect is null,
 * then the aspect ratio will be derived automatically from the canvas (and
 * updated as the canvas is being resized).
 *
 * @param ctx the context.
 * @param fovy the field of view (in degrees) in the Y direction.
 * @param aspect the view's aspect ratio, or null to track the canvas aspect ratio.
 * @param near the near clipping plane (> 0).
 * @param far the far clipping plane (> 0).
 */
View.perspective = function(ctx, fovy, aspect, near, far, options) {
    var ap = aspect;

    if (!aspect) {
        var w = ctx.gl.canvas.clientWidth;
        var h = ctx.gl.canvas.clientHeight;

        ap = w / h;
    }

    var ret = new View(ctx, View._make_perspective(fovy, ap, near, far), null, options);

    if (!aspect) {
        ret.updateViewport = function(ctx) {
            View.prototype.updateViewport.call(ret, ctx);

            if (ret._projection_set) {
                return;
            }

            var w = ctx.gl.canvas.clientWidth;
            var h = ctx.gl.canvas.clientHeight;

            var ap = w / h;

            ret._projection = View._make_perspective(fovy, ap, near, far);
        }
    }

    return ret;
}

/**
 * Create a view with an orthographic projection.
 *
 * @param ctx the context.
 * @param bounds the [left, right, top, bottom] (math.vec4) clipping planes.
 * @param near the near clipping plane.
 * @param far the far clipping plane.
 */
View.orthographic = function(ctx, bounds, near, far, options) {
    if (!bounds) {
        bounds = [0, 1, 0, 1];
    }

    var b = bounds;
    return new View(ctx, math.mat4.ortho(math.mat4.create(), b[0], b[1], b[2], b[3], near, far), null, options);
}

module.exports = View;

// vi:ts=4:et
