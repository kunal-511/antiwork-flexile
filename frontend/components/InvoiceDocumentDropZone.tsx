"use client";

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { AlertCircle, FileText, Loader2, Upload, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import clientEnv from "@/env/client";

// Schema for AI extraction
const invoiceDataSchema = z.object({
  isInvoice: z.boolean().describe("Whether this document is actually an invoice/receipt/bill (true) or not (false)"),
  lineItems: z
    .array(
      z.object({
        description: z.string().describe("Brief description of this specific service/work performed"),
        quantity: z.string().describe("Number of hours worked OR quantity for this item as a string"),
        hourly: z.boolean().describe("Whether this line item is hourly work (true) or project-based/fixed (false)"),
        payRateInSubunits: z
          .number()
          .describe("Hourly rate or unit price for this item in cents (multiply dollars by 100)"),
      }),
    )
    .describe("Array of line items from the invoice"),
  invoiceDate: z.string().describe("Invoice date in YYYY-MM-DD format"),
});

interface ExtractedLineItem {
  description: string;
  quantity: string;
  hourly: boolean;
  payRateInSubunits: number;
}

interface ExtractedInvoiceData {
  isInvoice: boolean;
  lineItems: ExtractedLineItem[];
  invoiceDate: string;
}

interface InvoiceDocumentDropZoneProps {
  onDataExtracted: (data: Omit<ExtractedInvoiceData, "isInvoice">) => void;
  disabled?: boolean;
}

type DropZoneState = "idle" | "processing" | "success" | "error" | "not-invoice";

export default function InvoiceDocumentDropZone({ onDataExtracted, disabled = false }: InvoiceDocumentDropZoneProps) {
  const [state, setState] = useState<DropZoneState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isDragActive, setIsDragActive] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [_, setDragCounter] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openaiProvider = createOpenAI({
    apiKey: clientEnv.NEXT_PUBLIC_OPENAI_API_KEY || "",
  });

  // Document processing using AI SDK
  const processDocument = async (file: File): Promise<ExtractedInvoiceData> => {
    if (!clientEnv.NEXT_PUBLIC_OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API key is not configured. Please add NEXT_PUBLIC_OPENAI_API_KEY to your environment variables.",
      );
    }

    let fileData: string;
    let contentType: "image" | "file";

    try {
      if (file.type.startsWith("image/")) {
        fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
            } else {
              reject(new Error("Failed to read image file"));
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        contentType = "image";
      } else if (file.type === "application/pdf") {
        const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (reader.result instanceof ArrayBuffer) {
              resolve(reader.result);
            } else {
              reject(new Error("Failed to read PDF file"));
            }
          };
          reader.onerror = reject;
          reader.readAsArrayBuffer(file);
        });

        const uint8Array = new Uint8Array(arrayBuffer);
        const binaryString = Array.from(uint8Array, (byte) => String.fromCharCode(byte)).join("");
        fileData = btoa(binaryString);
        contentType = "file";
      } else if (file.type === "text/plain") {
        fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
            } else {
              reject(new Error("Failed to read text file"));
            }
          };
          reader.onerror = reject;
          reader.readAsText(file);
        });
        contentType = "file";
      } else {
        throw new Error("Unsupported file type. Please upload an image, PDF, or text file.");
      }
    } catch (_error) {
      throw new Error("Failed to read the file. Please try a different file.");
    }

    try {
      const result = await generateObject({
        model: openaiProvider("gpt-4o-mini"),
        schema: invoiceDataSchema,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `FIRST: Determine if this document is an invoice, receipt, bill, or work statement.

If it's NOT an invoice/receipt/bill, set isInvoice=false and provide empty lineItems array.

If it IS an invoice/receipt/bill, set isInvoice=true and extract each service/product as a SEPARATE line item:

CRITICAL: Extract EACH service/product/work item as a SEPARATE object in the lineItems array.
- If you see "Consulting Services", "Web Design Project", "Content Management System" - create 3 separate line items
- If you see multiple rows in a table - create separate line items for each row
- If services are listed separately - extract each one individually

For each line item:
- description: Brief description of this specific service/work
- quantity: Number as a string (hours worked or quantity for this item)
- hourly: Boolean - true if hourly work, false if fixed price/project
- payRateInSubunits: Rate in cents for this item (dollars × 100)

Global fields:
- invoiceDate: Date in YYYY-MM-DD format

Rules for extraction:
- For hourly work: set hourly=true, extract hours and hourly rate
- For fixed projects: set hourly=false, quantity="1", extract total amount
- Convert all dollar amounts to cents (multiply by 100)
- Use today's date if no date is visible: ${new Date().toISOString().split("T")[0]}
- Be precise with numbers shown in the document
- ALWAYS create separate line items for each service/product listed

Examples of invoices: service bills, contractor invoices, freelance receipts, work statements
Examples of non-invoices: personal photos, random documents, contracts without billing info`,
              },
              ...(contentType === "image"
                ? [
                    {
                      type: "image" as const,
                      image: fileData.includes(",") ? (fileData.split(",")[1] ?? "") : fileData,
                    },
                  ]
                : [
                    {
                      type: "file" as const,
                      data: fileData,
                      mediaType: file.type,
                      filename: file.name,
                    },
                  ]),
            ],
          },
        ],
      });

      let extractedData = result.object;

      if (
        extractedData &&
        typeof extractedData === "object" &&
        "properties" in extractedData &&
        extractedData.properties
      ) {
        const properties = extractedData.properties;
        if (
          properties &&
          typeof properties === "object" &&
          "isInvoice" in properties &&
          "lineItems" in properties &&
          "invoiceDate" in properties
        ) {
          extractedData = {
            isInvoice: Boolean(properties.isInvoice),
            lineItems: Array.isArray(properties.lineItems) ? properties.lineItems : [],
            invoiceDate: String(properties.invoiceDate),
          };
        }
      }

      // Validate extracted data
      if (!extractedData || typeof extractedData !== "object") {
        throw new Error("Unable to analyze the document. Please try a clearer image or different file.");
      }

      if (!extractedData.isInvoice) {
        throw new Error("NOT_INVOICE");
      }

      if (!Array.isArray(extractedData.lineItems) || extractedData.lineItems.length === 0) {
        throw new Error("No line items found in the invoice.");
      }

      for (const item of extractedData.lineItems) {
        if (!item.description || typeof item.description !== "string") {
          throw new Error("Invalid service description detected in the document.");
        }

        if (item.payRateInSubunits < 0 || item.payRateInSubunits > 100000000) {
          throw new Error("Invalid payment amount detected in the document.");
        }

        const quantityNum = parseFloat(item.quantity);
        if (isNaN(quantityNum) || quantityNum <= 0 || quantityNum > 10000) {
          throw new Error("Invalid quantity/hours detected in the document.");
        }
      }

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(extractedData.invoiceDate)) {
        throw new Error("Invalid or missing date in the document.");
      }

      return extractedData;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "NOT_INVOICE") {
          throw error;
        }
        throw new Error(`processing failed: ${error.message}`);
      }
      throw new Error("Failed to process the document. Please try again or contact support.");
    }
  };

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (files.length === 0 || disabled) return;

      const file = files[0];
      if (!file) return;

      setFileName(file.name);

      // Validate file type
      const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf", "text/plain"];
      if (!validTypes.includes(file.type)) {
        setErrorMessage("Invalid file format. Please upload an image (JPG, PNG, WebP), PDF, or text file.");
        setState("error");
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        setErrorMessage("File too large. Please upload a file smaller than 10MB.");
        setState("error");
        return;
      }

      setState("processing");
      setErrorMessage("");

      try {
        const data = await processDocument(file);
        // Remove isInvoice from the data passed to parent
        const { isInvoice, ...invoiceData } = data;
        onDataExtracted(invoiceData);
        setTimeout(() => {
          resetState();
        }, 1000);
      } catch (error) {
        if (error instanceof Error && error.message === "NOT_INVOICE") {
          setState("not-invoice");
          setErrorMessage(
            "This doesn't appear to be an invoice or receipt. Please upload a billing document with payment information.",
          );
        } else {
          setState("error");
          setErrorMessage(error instanceof Error ? error.message : "Failed to process document. Please try again.");
        }
      }
    },
    [onDataExtracted, disabled],
  );

  useEffect(() => {
    const handleWindowDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!disabled && e.dataTransfer?.types.includes("Files")) {
        setDragCounter((prev) => prev + 1);
        setIsDragActive(true);
      }
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      e.preventDefault();
      setDragCounter((prev) => {
        const newCounter = prev - 1;
        if (newCounter <= 0) {
          setIsDragActive(false);
          return 0;
        }
        return newCounter;
      });
    };

    const handleWindowDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleWindowDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragActive(false);
      setDragCounter(0);

      if (!disabled && e.dataTransfer?.files) {
        handleFiles(e.dataTransfer.files);
      }
    };

    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);

    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [disabled, handleFiles]);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFiles(e.target.files);
      }
    },
    [handleFiles],
  );

  const resetState = () => {
    setState("idle");
    setErrorMessage("");
    setFileName("");
    setDragCounter(0);
    setIsDragActive(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileInput}
        accept="image/*,application/pdf,text/plain"
        className="hidden"
        disabled={disabled}
      />

      {isDragActive ? (
        <div
          className="fixed inset-0 z-50 bg-gray-500/20 backdrop-blur-sm transition-all duration-300 ease-out"
          style={{ cursor: "copy" }}
        >
          <div className="flex h-full items-center justify-center">
            <div className="animate-in fade-in-0 zoom-in-95 scale-100 transform rounded-2xl border-2 border-dashed border-blue-400 bg-white p-12 shadow-2xl duration-300">
              <div className="flex flex-col items-center space-y-6 text-center">
                <div className="flex items-center space-x-4">
                  <Upload className="h-12 w-12 text-blue-500" />
                  <FileText className="h-12 w-12 text-blue-500" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-gray-900">Drop your invoice here</h2>
                  <p className="max-w-md text-gray-600">Release to upload and automatically extract invoice data</p>
                  <p className="text-sm text-gray-400">Supports: Images (JPG, PNG, WebP), PDF, Text • Max 10MB</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {state === "processing" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-2xl bg-white p-12 text-center shadow-2xl">
            <div className="flex flex-col items-center space-y-6">
              <Loader2 className="h-16 w-16 animate-spin text-blue-600" />
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-blue-900">Analyzing document...</h2>
                {fileName ? <p className="max-w-xs truncate text-sm text-gray-500">{fileName}</p> : null}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {errorMessage && (state === "error" || state === "not-invoice") ? (
          <Alert variant={state === "not-invoice" ? "default" : "destructive"} className="border-l-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between text-sm leading-relaxed">
              <span>{errorMessage}</span>
              <Button variant="outline" size="small" onClick={resetState} className="ml-4 gap-2">
                <X className="h-4 w-4" />
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {state === "not-invoice" && (
          <Alert variant="default" className="border-l-4 border-l-orange-500">
            <FileText className="h-4 w-4 text-orange-500" />
            <AlertDescription className="flex items-center justify-between">
              <div>
                <p className="font-medium text-orange-800">Not an invoice document</p>
                <p className="text-sm text-orange-600">Please upload a billing document instead</p>
              </div>
              <Button variant="outline" size="small" onClick={resetState} className="ml-4 gap-2">
                <Upload className="h-4 w-4" />
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {state === "idle" && !isDragActive && (
          <div className="text-center">
            <p className="text-sm text-gray-500">
              Drag and drop an invoice anywhere on this page to auto-fill the form
            </p>
          </div>
        )}
      </div>
    </>
  );
}
