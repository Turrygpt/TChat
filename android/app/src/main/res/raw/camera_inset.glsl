#extension GL_OES_EGL_image_external : require
precision mediump float;

uniform sampler2D uSampler;
uniform samplerExternalOES uObject;
uniform mat4 uInsetTransform;
uniform float uAlpha;

varying vec2 vTextureCoord;
varying vec2 vTextureObjectCoord;

void main() {
    vec4 mainColor = texture2D(uSampler, vTextureCoord);
    vec2 inset = vTextureObjectCoord;
    if (uAlpha == 0.0 || inset.x < 0.0 || inset.x > 1.0 || inset.y < 0.0 || inset.y > 1.0) {
        gl_FragColor = mainColor;
    } else {
        vec2 uv = (uInsetTransform * vec4(inset.x, 1.0 - inset.y, 0.0, 1.0)).xy;
        gl_FragColor = texture2D(uObject, uv);
    }
}
