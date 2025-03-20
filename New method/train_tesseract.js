import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';

const TRAINING_DATA_DIR = 'training_data';
const TRAINED_MODEL_DIR = 'trained_model';

async function trainTesseract() {
    // Create directories if they don't exist
    if (!fs.existsSync(TRAINING_DATA_DIR)) {
        fs.mkdirSync(TRAINING_DATA_DIR);
    }
    if (!fs.existsSync(TRAINED_MODEL_DIR)) {
        fs.mkdirSync(TRAINED_MODEL_DIR);
    }

    // Initialize Tesseract worker with training mode
    const worker = await createWorker({
        logger: m => console.log(m)
    });

    try {
        await worker.loadLanguage('eng');
        await worker.initialize('eng');

        // Get list of training images
        const trainingFiles = fs.readdirSync(TRAINING_DATA_DIR)
            .filter(file => file.endsWith('.png') || file.endsWith('.jpg'));

        console.log(`Found ${trainingFiles.length} training images`);

        // Process each training image
        for (const file of trainingFiles) {
            const imagePath = path.join(TRAINING_DATA_DIR, file);
            const groundTruth = file.split('_')[0]; // Assuming filename format: "text_timestamp.png"

            console.log(`Training with image ${file}, expected text: ${groundTruth}`);

            // Add image to training data
            await worker.addImage(imagePath, {
                text: groundTruth,
                mode: 'training'
            });
        }

        // Train the model
        console.log('Starting model training...');
        await worker.train({
            langdata: path.join(TRAINED_MODEL_DIR, 'captcha'),
            iterations: 1000,
            batchSize: 10
        });

        // Save the trained model
        await worker.save(path.join(TRAINED_MODEL_DIR, 'captcha.traineddata'));
        console.log('Model training completed and saved');

    } catch (error) {
        console.error('Error during training:', error);
    } finally {
        await worker.terminate();
    }
}

// Function to save CAPTCHA image for training
export async function saveCaptchaForTraining(imageBuffer, text) {
    if (!fs.existsSync(TRAINING_DATA_DIR)) {
        fs.mkdirSync(TRAINING_DATA_DIR);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${text}_${timestamp}.png`;
    const filepath = path.join(TRAINING_DATA_DIR, filename);

    fs.writeFileSync(filepath, imageBuffer);
    console.log(`Saved training image: ${filepath}`);
}

// Run training if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    trainTesseract().catch(console.error);
}

export { trainTesseract }; 