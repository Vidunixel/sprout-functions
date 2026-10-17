import express from 'express';
import multer from 'multer';
import * as THREE from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { createCanvas } from 'canvas';
import { JSDOM } from 'jsdom';
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import createOpenSCAD from '@lofcz/openscad-wasm';

// ==========================================
// 1. WASM Setup (Executed once on cold start)
// ==========================================
const require = createRequire(import.meta.url);
const mainScriptPath = require.resolve('@lofcz/openscad-wasm');
const wasmPath = join(dirname(mainScriptPath), 'openscad.wasm');
const wasmBytes = readFileSync(wasmPath);

// ==========================================
// 2. Multer Configuration & Validation
// ==========================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024, // Limit to 25 MB
    },
    fileFilter: (req, file, cb) => {
        // Strict validation: Reject non-SCAD files before processing
        if (!file.originalname.toLowerCase().endsWith('.scad')) {
            return cb(new Error('Invalid file type. Only .scad files are allowed.'));
        }
        cb(null, true);
    }
});

const app = express();

// ==========================================
// 3. API Route
// ==========================================
app.post('/convert-scad', (req, res, next) => {
    // Wrap Multer to catch validation/size errors and return clean JSON
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        const scadContent = req.file.buffer.toString('utf-8');

        // Step A: SCAD -> 3MF (Handles Manifold geometry generation)
        const arrayBuffer3MF = await convertScadTo3MF(scadContent);

        // Step B: 3MF -> USDZ (Handles Three.js XML parsing and material fixes)
        const usdzBuffer = await convert3MFToUSDZ(arrayBuffer3MF);

        // Step C: Send Response
        const outputFilename = req.file.originalname.replace(/\.scad$/i, '.usdz');
        res.setHeader('Content-Type', 'model/vnd.usdz+zip');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
        res.setHeader('Content-Length', usdzBuffer.length);

        return res.send(usdzBuffer);

    } catch (error) {
        console.error('Conversion Error:', error);
        return res.status(500).json({ error: 'Failed to convert file: ' + error.message });
    }
});

// ==========================================
// 4. Helper Functions
// ==========================================

async function convertScadTo3MF(scadContent) {
    const instance = await createOpenSCAD({
        noInitialRun: true,
        instantiateWasm(imports, done) {
            WebAssembly.instantiate(wasmBytes, imports).then((r) => done(r.instance));
            return {};
        },
    });

    instance.FS.writeFile('/input.scad', scadContent);

    // Export using the pre-compiled Manifold engine
    instance.callMain([
        '/input.scad',
        '--enable=manifold',
        '-o', '/output.3mf'
    ]);

    const fileData = instance.FS.readFile('/output.3mf');

    // Clean up virtual filesystem
    instance.FS.unlink('/input.scad');
    instance.FS.unlink('/output.3mf');

    return fileData.buffer.slice(
      fileData.byteOffset,
      fileData.byteOffset + fileData.byteLength
    );
}

async function convert3MFToUSDZ(arrayBuffer3MF) {
    // Setup temporary browser globals for Three.js XML Parsing
    const { window } = new JSDOM();
    global.window = window;
    global.document = window.document;
    global.DOMParser = window.DOMParser;
    document.createElement = function (tagName) {
        if (tagName.toLowerCase() === 'canvas') {
            return createCanvas(256, 256);
        }
        return window.document.createElement(tagName);
    };

    try {
        const loader = new ThreeMFLoader();
        const group = loader.parse(arrayBuffer3MF);

        // Fix Normals and Convert Materials for USDZ compatability
        group.traverse((child) => {
            if (child.isMesh) {
                if (!child.geometry.attributes.normal) {
                    child.geometry.computeVertexNormals();
                }

                const convertMaterial = (oldMat) => {
                    return new THREE.MeshStandardMaterial({
                        color: oldMat.color || new THREE.Color(0xcccccc),
                        roughness: 0.6,
                        metalness: 0.1,
                        vertexColors: oldMat.vertexColors || false
                    });
                };

                if (Array.isArray(child.material)) {
                    child.material = child.material.map(convertMaterial);
                } else {
                    child.material = convertMaterial(child.material);
                }
            }
        });

        // Center the geometry
        const boundingBox = new THREE.Box3().setFromObject(group);
        const center = boundingBox.getCenter(new THREE.Vector3());
        group.position.sub(center);

        const scene = new THREE.Scene();
        scene.add(group);

        // Export to USDZ
        const exporter = new USDZExporter();
        const rawUsdz = await new Promise((resolve, reject) => {
            try {
                const result = exporter.parse(scene, resolve, reject);
                if (result instanceof Promise || (result && typeof result.then === 'function')) {
                    result.then(resolve).catch(reject);
                } else if (result !== undefined) {
                    resolve(result);
                }
            } catch(e) {
                reject(e);
            }
        });

        if (!rawUsdz) throw new Error('USDZ Exporter returned empty data.');
        return Buffer.isBuffer(rawUsdz) ? rawUsdz : Buffer.from(rawUsdz);

    } finally {
        // Guarantee cleanup of globals even if Three.js throws an error
        delete global.window;
        delete global.document;
        delete global.DOMParser;
    }
}

export default app;