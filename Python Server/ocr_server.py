from flask import Flask, request, jsonify
import easyocr
import os

app = Flask(__name__)
reader = easyocr.Reader(['en'])  # Initialize EasyOCR for English

@app.route('/ocr', methods=['POST'])
def ocr():
    print("Received request:", request.json)
    if not request.json or 'image_path' not in request.json:
        print("Invalid request payload")
        return jsonify({'error': 'Invalid request payload'}), 400

    image_path = request.json['image_path']
    print("Image path:", image_path)
    
    if not os.path.exists(image_path):
        print("Image file not found:", image_path)
        return jsonify({'error': f'Image file not found at: {image_path}'}), 404

    try:
        result = reader.readtext(image_path, detail=0)
        text = ''.join(result).replace(' ', '').strip()
        print("Extracted text:", text)
        return jsonify({'text': text})
    except Exception as e:
        print(f"Error processing image: {str(e)}")
        return jsonify({'error': f'Error processing image: {str(e)}'}), 500

if __name__ == '__main__':
    print(f"Flask server running in directory: {os.getcwd()}")
    app.run(port=5000)