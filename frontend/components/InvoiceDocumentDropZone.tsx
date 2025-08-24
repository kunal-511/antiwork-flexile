"use client";

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { AlertCircle, CheckCircle, FileText, Loader2, Upload } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import clientEnv from "@/env/client";

// Schema for AI extraction
const invoiceDataSchema = z.object({
  description: z.string().describe("Brief description of services/work performed"),
  quantity: z.string().describe("Number of hours worked OR quantity of items/services as a string"),
  hourly: z.boolean().describe("Whether this is hourly work (true) or project-based/fixed (false)"),
  payRateInSubunits: z.number().describe("Hourly rate or unit price in cents (multiply dollars by 100)"),
  invoiceDate: z.string().describe("Invoice date in YYYY-MM-DD format"),
});

interface ExtractedInvoiceData {
  description: string;
  quantity: string;
  hourly: boolean;
  payRateInSubunits: number;
  invoiceDate: string;
}

interface InvoiceDocumentDropZoneProps {
  onDataExtracted: (data: ExtractedInvoiceData) => void;
  disabled?: boolean;
}

type DropZoneState = "idle" | "processing" | "success" | "error";

export default function InvoiceDocumentDropZone({ onDataExtracted, disabled = false }: InvoiceDocumentDropZoneProps) {
  const [state, setState] = useState<DropZoneState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [extractedData, setExtractedData] = useState<ExtractedInvoiceData | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
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
    } else {
      throw new Error("Unsupported file type");
    }

    const result = await generateObject({
      model: openaiProvider("gpt-4o-mini"),
      schema: invoiceDataSchema,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract invoice data from this document (image or PDF). Return only the extracted values, not a schema.

Analyze the image and extract these exact fields:
- description: Brief description of the work/service
- quantity: Number as a string (hours worked or quantity)
- hourly: Boolean - true if hourly work, false if fixed price
- payRateInSubunits: Rate in cents (dollars × 100)
- invoiceDate: Date in YYYY-MM-DD format

Rules:
- Return actual extracted data, not a JSON schema
- For hourly work: set hourly=true, extract hours and rate
- For fixed projects: set hourly=false, quantity="1"
- Convert dollar amounts to cents (multiply by 100)
- Use today's date if no date visible: ${new Date().toISOString().split("T")[0]}
- Be accurate with numbers visible in the document`,
            },
            ...(contentType === "image"
              ? [
                  {
                    type: "image" as const,
                    image: fileData.split(",")[1] || fileData,
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
      // Type guard for properties
      const properties = extractedData.properties;
      if (
        properties &&
        typeof properties === "object" &&
        "description" in properties &&
        "quantity" in properties &&
        "hourly" in properties &&
        "payRateInSubunits" in properties &&
        "invoiceDate" in properties
      ) {
        extractedData = {
          description: String(properties.description),
          quantity: String(properties.quantity),
          hourly: Boolean(properties.hourly),
          payRateInSubunits: Number(properties.payRateInSubunits),
          invoiceDate: String(properties.invoiceDate),
        };
      }
    }

    // Validate extracted data
    if (!extractedData || typeof extractedData !== "object") {
      throw new Error("Invalid response format from AI");
    }

    if (extractedData.payRateInSubunits < 0 || extractedData.payRateInSubunits > 100000000) {
      throw new Error("Invalid rate detected");
    }

    if (parseFloat(extractedData.quantity) <= 0 || parseFloat(extractedData.quantity) > 10000) {
      throw new Error("Invalid quantity detected");
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(extractedData.invoiceDate)) {
      throw new Error("Invalid date format");
    }

    return extractedData;
  };

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (files.length === 0 || disabled) return;

      const file = files[0];
      if (!file) return;

      // Validate file type
      const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf", "text/plain"];
      if (!validTypes.includes(file.type)) {
        setErrorMessage("Please upload an image (JPG, PNG, WebP), PDF, or text file.");
        setState("error");
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        setErrorMessage("File size must be less than 10MB.");
        setState("error");
        return;
      }

      setState("processing");
      setErrorMessage("");

      try {
        const data = await processDocument(file);
        setExtractedData(data);
        setState("success");
        onDataExtracted(data);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to process document");
        setState("error");
      }
    },
    [onDataExtracted, disabled],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        setIsDragActive(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);

      if (!disabled && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [disabled, handleFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFiles(e.target.files);
      }
    },
    [handleFiles],
  );

  const handleClick = useCallback(() => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, [disabled]);

  const resetState = () => {
    setState("idle");
    setErrorMessage("");
    setExtractedData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const getBorderColor = () => {
    if (state === "success") return "border-green-500";
    if (state === "error") return "border-red-500";
    if (isDragActive) return "border-blue-500";
    return "border-dashed border-gray-300";
  };

  const getBackgroundColor = () => {
    if (state === "success") return "bg-green-50";
    if (state === "error") return "bg-red-50";
    if (isDragActive) return "bg-blue-50";
    return "bg-gray-50";
  };

  return (
    <div className="w-full">
      <Card className={`transition-all duration-200 ${getBorderColor()} ${getBackgroundColor()}`}>
        <CardContent className="p-6">
          <div
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleClick}
            className={`cursor-pointer text-center ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileInput}
              accept="image/*,application/pdf,text/plain"
              className="hidden"
              disabled={disabled}
            />

            <div className="flex flex-col items-center space-y-4">
              {state === "processing" && (
                <>
                  <Loader2 className="h-12 w-12 animate-spin text-blue-500" />
                  <div>
                    <p className="text-lg font-medium">Processing document...</p>
                    <p className="text-sm text-gray-500">AI is extracting invoice information</p>
                  </div>
                </>
              )}

              {state === "success" && (
                <>
                  <CheckCircle className="h-12 w-12 text-green-500" />
                  <div>
                    <p className="text-lg font-medium text-green-700">Data extracted successfully!</p>
                    <p className="text-sm text-gray-500">Invoice fields have been filled automatically</p>
                  </div>
                </>
              )}

              {state === "error" && (
                <>
                  <AlertCircle className="h-12 w-12 text-red-500" />
                  <div>
                    <p className="text-lg font-medium text-red-700">Failed to process document</p>
                    <p className="text-sm text-gray-500">Please try again or fill manually</p>
                  </div>
                </>
              )}

              {state === "idle" && (
                <>
                  <div className="flex items-center space-x-2">
                    <Upload className="h-8 w-8 text-gray-400" />
                    <FileText className="h-8 w-8 text-gray-400" />
                  </div>
                  <div>
                    <p className="text-lg font-medium">
                      {isDragActive ? "Drop document here" : "Drag & drop receipt or document"}
                    </p>
                    <p className="text-sm text-gray-500">Or click to browse • Supports images, PDFs, and text files</p>
                  </div>
                </>
              )}
            </div>
          </div>

          {(state === "success" || state === "error") && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" size="small" onClick={resetState}>
                Process Another Document
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {state === "error" && errorMessage ? (
        <Alert className="mt-4" variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {state === "success" && extractedData ? (
        <Alert className="mt-4">
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-1">
              <p>
                <strong>Extracted:</strong> {extractedData.description}
              </p>
              <p>
                <strong>Amount:</strong> ${(extractedData.payRateInSubunits / 100).toFixed(2)} ×{" "}
                {extractedData.quantity} {extractedData.hourly ? "hours" : "units"}
              </p>
              <p>
                <strong>Date:</strong> {extractedData.invoiceDate}
              </p>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
