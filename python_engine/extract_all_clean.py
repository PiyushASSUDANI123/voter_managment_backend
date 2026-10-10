#!/usr/bin/env python3
"""
High-Precision Full Extraction of 01.pdf
Outputs clean JSON map keyed by EPIC
"""
import sys
import os
import json
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from pdf_to_excel import ocr_single_page, clean_hindi_name, clean_house_no
import fitz

def extract_all(pdf_path: str, out_json_path: str):
    if not os.path.exists(pdf_path):
        print(f"File not found: {pdf_path}")
        sys.exit(1)

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()

    print(f"Extracting {total_pages} pages from {pdf_path} using 6 threads...")
    t0 = time.time()

    tasks = [(pdf_path, p) for p in range(total_pages)]
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(ocr_single_page, tasks))

    results.sort(key=lambda x: x[0])

    card_map = {}
    total_cards = 0

    for p_idx, page_cards, page_epics in results:
        for c in page_cards:
            epic = c.get("epic", "").strip().upper()
            if epic and len(epic) >= 5:
                # Sanitize once more
                name = clean_hindi_name(c.get("nameHi", ""))
                rel_name = clean_hindi_name(c.get("relativeNameHi", ""))
                house = clean_house_no(c.get("houseNo", ""))
                age = c.get("age")
                gender = c.get("gender", "पुरुष")
                rel_type = c.get("relationType", "पिता")

                if epic not in card_map or (name and len(name) > len(card_map[epic].get("nameHi", ""))):
                    card_map[epic] = {
                        "epic": epic,
                        "nameHi": name,
                        "relativeNameHi": rel_name,
                        "relationType": rel_type,
                        "houseNo": house,
                        "age": age,
                        "gender": gender,
                        "status": c.get("status", "Active"),
                        "page": p_idx + 1
                    }
                total_cards += 1

    t1 = time.time()
    print(f"Extraction complete in {t1 - t0:.2f} seconds.")
    print(f"Total cards processed: {total_cards}, Unique clean EPICs: {len(card_map)}")

    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump(card_map, f, ensure_ascii=False, indent=2)

    print(f"Saved to {out_json_path}")

if __name__ == "__main__":
    pdf = "/Users/piyush/Documents/moxrathore_projects/vijaysetu/01.pdf"
    out = "/tmp/clean_voters_extracted.json"
    extract_all(pdf, out)
