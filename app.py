import streamlit as st
import pandas as pd
import json
import io

# Page Configuration
st.set_page_config(page_title="Invoice Data Extractor", layout="wide")

st.title("📄 Invoice Extractor & Excel Generator")
st.markdown("Upload invoice PDFs or images below to parse details directly into Excel rows.")

# Imports wrapped in try-except to report errors visually instead of crashing
try:
    import google.generativeai as genai
    from PIL import Image
except Exception as e:
    st.error(f"Failed to import required libraries: {e}")
    st.stop()

# Sidebar for API Key configuration
with st.sidebar:
    st.header("Settings")
    api_key = st.text_input("Enter Gemini API Key:", type="password")
    st.markdown("[Get a free Gemini API Key here](https://aistudio.google.com/)")

# Field definitions
FIELDS = [
    "Product Title", "SKU Code", "CRM Order ID", "Cost Price", "Supplier Name",
    "Dispatched Through", "Billing City", "FSN Details for Creatives - Tyresnmore.",
    "Product", "HAS OFFER", "TNM Discount", "Order Date", "Quantity",
    "Total Invoice Amount", "Selling Price Per Item", "Pre GST Price",
    "Shipping Charge Per Item", "Total (includes FKMP contribution)", "Invoice No.",
    "Invoice Amount", "TNM Billing Invoice Date (mm/dd/yy)", "Tax Ledger", "CGST",
    "SGST", "IGST", "Buyer Name", "Ship To Name", "Address Line 1", "Address Line 2",
    "City", "State", "PIN Code", "Phone No", "Email Id", "HSN"
]

uploaded_files = st.file_uploader(
    "Upload Invoices (PDF, PNG, JPG, JPEG)", 
    type=["pdf", "png", "jpg", "jpeg"], 
    accept_multiple_files=True
)

def extract_invoice_data(file_bytes, file_type, api_key):
    genai.configure(api_key=api_key)
    
    # Fallback list for active model versions
    model_candidates = ['gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
    model = None
    
    for model_name in model_candidates:
        try:
            model = genai.GenerativeModel(model_name)
            break
        except Exception:
            continue
            
    if not model:
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
    
    # Clean JSON output
    clean_text = response.text.strip().removeprefix("```json").removesuffix("```").strip()
    return json.loads(clean_text)

if uploaded_files:
    if not api_key:
        st.warning("Please enter your Gemini API Key in the sidebar to process invoices.")
    else:
        if st.button(f"Process {len(uploaded_files)} Invoice(s)", type="primary"):
            extracted_rows = []
            progress_bar = st.progress(0)

            for idx, file in enumerate(uploaded_files):
                st.write(f"Processing: **{file.name}**...")
                try:
                    file_bytes = file.read()
                    data = extract_invoice_data(file_bytes, file.type, api_key)
                    data["Filename"] = file.name
                    extracted_rows.append(data)
                except Exception as e:
                    st.error(f"Error processing {file.name}: {e}")
                
                progress_bar.progress((idx + 1) / len(uploaded_files))

            if extracted_rows:
                df = pd.DataFrame(extracted_rows)
                cols = ["Filename"] + [f for f in FIELDS if f in df.columns]
                df = df[cols]

                st.success("Extraction Complete!")
                st.subheader("Extracted Invoice Data")
                st.dataframe(df, use_container_width=True)

                output = io.BytesIO()
                with pd.ExcelWriter(output, engine='openpyxl') as writer:
                    df.to_excel(writer, index=False, sheet_name='Invoices')
                excel_data = output.getvalue()

                st.download_button(
                    label="📥 Download Excel File",
                    data=excel_data,
                    file_name="Extracted_Invoices.xlsx",
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                )
