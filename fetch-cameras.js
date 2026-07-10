// fetch-cameras.js
// Fetches all NCDOT camera data (coordinates, roadway, direct video URLs)
// from the official DriveNC Cameras API and saves it as a static JSON file.
//
// Run with: node fetch-cameras.js
// Requires env var CAMERA_API_KEY to be set.

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.CAMERA_API_KEY;

if (!API_KEY) {
    console.error('❌ Missing CAMERA_API_KEY environment variable.');
    process.exit(1);
}

const API_URL = `https://www.drivenc.gov/api/v2/get/cameras?key=${API_KEY}&format=json`;

async function run() {
    console.log('Fetching camera list from DriveNC API...');

    const resp = await fetch(API_URL);
    if (!resp.ok) {
        console.error(`❌ API request failed: ${resp.status} ${resp.statusText}`);
        process.exit(1);
    }

    const rawCameras = await resp.json();
    console.log(`✅ Received ${rawCameras.length} camera records.`);

    // Flatten to just what the phone page needs.
    // Each raw record can have multiple "Views" (usually 1), so we
    // expand to one entry per view with a direct playable VideoUrl.
    const cameras = [];

    for (const cam of rawCameras) {
        if (!cam.Views || !cam.Views.length) continue;

        for (const view of cam.Views) {
            if (view.Status !== 'Enabled') continue;
            if (!view.VideoUrl) continue;

            cameras.push({
                id: view.Id,
                roadway: cam.Roadway,
                direction: cam.Direction || null,
                lat: cam.Latitude,
                lon: cam.Longitude,
                location: cam.Location || view.Description || '',
                county: view.County || null,
                videoUrl: view.VideoUrl,
            });
        }
    }

    console.log(`✅ Flattened to ${cameras.length} playable camera views.`);

    const output = {
        updated: new Date().toISOString(),
        count: cameras.length,
        cameras,
    };

    const outPath = path.join(__dirname, 'cameras.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
    console.log(`🎉 Saved to ${outPath}`);
}

run().catch(err => {
    console.error('⛔ Error:', err);
    process.exit(1);
});
