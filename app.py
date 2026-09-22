def extract_invoice_data(file_bytes, file_type, api_key):
    genai.configure(api_key=api_key)
    # Updated to active model version
    model = genai.GenerativeModel('gemini-2.5-flash')

    prompt = f"""
    Extract the following key fields from this invoice document into a strict JSON object. 
    If a field is missing or not applicable, set its value to "".
    
    Fields to extract:
    {json.dumps(FIELDS)}

    Return ONLY a valid JSON object with the fields above as keys.
    """

    if file_type == "application/pdf":
        doc_part = {"mime_type": "application/pdf", "data": file_bytes}
    else:
        doc_part = Image.open(io.BytesIO(file_bytes))

    response = model.generate_content([doc_part, prompt])
    
    # Clean JSON response
    clean_text = response.text.strip().removeprefix("```json").removesuffix("```").strip()
    return json.loads(clean_text)