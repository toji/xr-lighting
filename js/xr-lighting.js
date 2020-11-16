// Copyright 2019 Brandon Jones
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import * as THREE from './third-party/three.js/build/three.module.js';
import { RGBELoader } from './third-party/three.js/examples/jsm/loaders/RGBELoader.js';

export class XRLighting extends THREE.Group {
  constructor(renderer) {
    super();

    this._renderer = renderer;
    this._pmremGenerator = new THREE.PMREMGenerator(renderer);

    this._hemisphereLight = new THREE.HemisphereLight(0xFFFFFF, 0x448844);
    this.add(this._hemisphereLight);

    this._equirect = null;
    this._envMap = null;

    this._xrSession = null;
    this._sessionLightProbe = null;

    this._xrEnvMap = null;
    this._xrLightProbe = null;
    this._xrDirectionalLight = null;
    this._xrWebGLBinding = null;
    this._colorBufferFloatExt = null;

    this._xrReflectionTexture = null;
    this._xrReflectionCubeMap = null;
    this._xrLastReflectionUpdate = 0;

    this._xrFrameCallback = (time, xrFrame) => { this.onXRFrame(time, xrFrame); };
  }

  loadHDRSkybox(url) {
    this._pmremGenerator.compileEquirectangularShader();

    return new Promise((resolve) => {
      let rgbeLoader = new RGBELoader();
      rgbeLoader.setDataType(THREE.UnsignedByteType);
      rgbeLoader.load(url, (texture) => {
        this._equirect = texture;
        this._envMap = this._pmremGenerator.fromEquirectangular(this._equirect).texture;
        if (!this._xrEnvMap) {
          this.dispatchEvent( { type: 'envmapchange' } );
        }
        resolve(this._envMap);
      });
    });
  }

  get envMap() {
    return this._xrEnvMap ? this._xrEnvMap : this._envMap;
  }

  set xrSession(value) {
    if (this._xrSession == value) return;

    this._xrSession = value;

    if (!this._xrSession) {
      this._sessionLightProbe = null;
      this._xrWebGLBinding = null;
      this._colorBufferFloatExt = null;

      // Revert back to app-specific lighting.
      if (this._xrLightProbe) {
        this.remove(this._xrLightProbe);
        this._xrLightProbe = null;

        this.add(this._hemisphereLight);
      }

      if (this._xrDirectionalLight) {
        this.remove(this._xrDirectionalLight);
        this._xrDirectionalLight = null;
      }

      if (this._xrEnvMap) {
        this._xrEnvMap.dispose();
        this._xrEnvMap = null;
        this.dispatchEvent( { type: 'envmapchange' } );
      }
    } else {
      if ('requestLightProbe' in this._xrSession) {
        // Indicate that we want to start tracking lighting estimation if it's
        // available.
        this._xrSession.requestLightProbe({
          reflectionFormat: this._xrSession.preferredReflectionFormat
        }).then((probe) => {
          const gl = this._renderer.getContext();
          this._sessionLightProbe = probe;

          if ('XRWebGLBinding' in window) {
            this._xrWebGLBinding = new XRWebGLBinding(this._xrSession, gl);
            this.srgb_ext = gl.getExtension('EXT_sRGB');
            this._textureHalfFloatExt = gl.getExtension('OES_texture_half_float');

            setInterval(() => {
              this.updateReflection();
            }, 1000);

            /*probe.addEventListener('reflectionchange', () => {
              this.updateReflection();
            });*/
          }

          if (!this._xrEnvMap) {
            const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(16);
            this._xrEnvMap = cubeRenderTarget.texture;
            this.dispatchEvent({ type: 'envmapchange' });
          }

          // Start monitoring the XR animation frame loop to look for lighting
          // estimation changes.
          this._xrSession.requestAnimationFrame(this._xrFrameCallback);

          this._pmremGenerator.compileCubemapShader();
        });
      }
    }
  }

  get xrSession() {
    return this._xrSession;
  }

  updateReflection() {
    if (!this._xrWebGLBinding) return;

    const cubeMap = this._xrWebGLBinding.getReflectionCubeMap(this._sessionLightProbe);
    if (!cubeMap) return;

    const textureProperties = this._renderer.properties.get(this._xrEnvMap);
    if (textureProperties) {
      textureProperties.__webglTexture = cubeMap;
    }
  }

  onXRFrame(time, xrFrame) {
    this._xrSession.requestAnimationFrame(this._xrFrameCallback);

    if (this._sessionLightProbe) {
      let lightEstimate = xrFrame.getLightEstimate(this._sessionLightProbe);
      if (lightEstimate) {
        if (!this._xrLightProbe) {
          this._xrLightProbe = new THREE.LightProbe();
          this._xrLightProbe.intensity = 1;
          this.add(this._xrLightProbe);

          this.remove(this._hemisphereLight);
        }

        if (!this._xrDirectionalLight) {
          this._xrDirectionalLight = new THREE.DirectionalLight();
          this.add(this._xrDirectionalLight);
        }

        this._xrLightProbe.sh.fromArray(lightEstimate.sphericalHarmonicsCoefficients);

        let intensityScalar = Math.max(1.0,
                              Math.max(lightEstimate.primaryLightIntensity.x,
                              Math.max(lightEstimate.primaryLightIntensity.y,
                                       lightEstimate.primaryLightIntensity.z)));

        this._xrDirectionalLight.color.setRGB(lightEstimate.primaryLightIntensity.x / intensityScalar,
                                              lightEstimate.primaryLightIntensity.y / intensityScalar,
                                              lightEstimate.primaryLightIntensity.z / intensityScalar);
        this._xrDirectionalLight.intensity = intensityScalar;
        this._xrDirectionalLight.position.copy(lightEstimate.primaryLightDirection);
      }
    }
  }
}