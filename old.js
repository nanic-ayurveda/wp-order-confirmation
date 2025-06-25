require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

// HMAC Verification Middleware
// function verifyShopifyWebhook(req, res, next) {
//   const hmacHeader = req.headers["x-shopify-hmac-sha256"];
//   const digest = crypto
//     .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
//     .update(req.rawBody)
//     .digest("base64");

//   if (digest === hmacHeader) {
//     return next();
//   } else {
//     console.warn("⚠️ HMAC validation failed!");
//     console.log("🔍 Expected:", digest);
//     console.log("📬 Received:", hmacHeader);
//     return res.status(401).send("Unauthorized - HMAC validation failed");
//   }
// }


// Handle Webhook
app.post("/webhook", async (req, res) => {
  const order = req.body;
  const customer = order.customer;
  const total = order.total_price;
  const orderId = order.name;
  const phone = customer.phone || customer.default_address?.phone || "Not Provided";
  const address = order.shipping_address;
  const paymentMethod = order.gateway; // e.g., 'razorpay', 'cash on delivery'

  const fullAddress = `${address.name}, ${address.address1}, ${address.address2 || ""}, ${address.city}, ${address.province}, ${address.zip}, ${address.country}`;

  // Format product list
  const products = order.line_items
    .map((item, index) => `${index + 1}. ${item.name} - ${item.quantity} nos`)
    .join("\n");

  const message = `Dear Arun,\n\n` +
    `🛍️ New Order received on Shopify. Please visit Shopify and fulfill the items.\n\n` +
    `📦 Order ID: ${orderId}\n` +
    `👤 Customer Name: ${customer.first_name} ${customer.last_name}\n` +
    `📱 Contact No: ${phone}\n` +
    `🚚 Shipping Address:\n${fullAddress}\n` +
    `💳 Payment Method: ${paymentMethod}\n` +
    `🧾 Products:\n${products}\n\n` +
    `💰 Total Amount: ₹${total}\n\n` +
    `Thanks and Regards,\nNanic Ayurveda Bot`;

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: process.env.TO_WHATSAPP_NUMBER,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).send("OK");
  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
    res.status(500).send("Failed to send WhatsApp message");
  }
});

// Function to send WhatsApp template message to customer
const sendCustomerWhatsapp = async (phone, templateName, params) => {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: params.map((text) => ({ type: "text", text })),
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Customer WhatsApp Error:", err.response?.data || err.message);
  }
};


// Utility function to sanitize phone numbers
const sanitizePhone = (rawPhone) => {
  if (!rawPhone) return null;
  // Remove all non-digit characters
  const digits = rawPhone.replace(/\D/g, "");
  // Ensure it starts with 91 (India)
  if (digits.startsWith("91")) return digits;
  if (digits.length === 10) return `91${digits}`;
  return null; // invalid
};

const getCustomerPhone = (customer) => {
  if (!customer) return null;

  const rawPhone =
    customer.phone ||
    customer.default_address?.phone ||
    null;

  if (!rawPhone) return null;

  // Remove spaces and "+" sign to format like 91XXXXXXXXXX
  return rawPhone.replace(/\s+/g, "").replace(/^\+/, "");
};


app.post("/order-placed", async (req, res) => {
  const order = req.body;

  if (!order || typeof order !== "object") {
    console.error("❌ Invalid or empty order payload.");
    return res.status(400).send("Invalid payload");
  }

  const customer = order.customer;
  if (!customer) {
    console.error("❌ Order received but 'customer' field is missing:", JSON.stringify(order, null, 2));
    return res.status(400).send("Missing customer info");
  }

  const phone = getCustomerPhone(customer);
  if (!phone) {
    console.error("❌ Phone number not found in 'customer' or 'customer.default_address'");
    return res.status(400).send("Missing phone number");
  }

  const productsList = Array.isArray(order.line_items)
    ? order.line_items
        .map((item, idx) => `${idx + 1}. ${item.name} - ${item.quantity} no${item.quantity > 1 ? "s" : ""}`)
        .join("\n")
    : "No items";

  const totalAmount = order.total_price || "N/A";

  await sendCustomerWhatsapp(
    phone,
    "order_confirmation",
    [
      customer.first_name || "Customer",
      order.name || "Order",
      totalAmount.toString(),
      productsList
    ]
  );

  res.sendStatus(200);
});



app.post("/order-fulfilled", async (req, res) => {
  const order = req.body;

  const customer = order.customer;
  if (!customer || typeof customer !== "object") {
    console.error("❌ Order received but 'customer' field is missing:", JSON.stringify(order, null, 2));
    return res.status(400).send("Missing customer info");
  }

  const phone = getCustomerPhone(customer);
  if (!phone) {
    console.error("❌ Phone number not found in 'customer' or 'customer.default_address'");
    return res.status(400).send("Missing phone number");
  }

  const shippedItems = Array.isArray(order.line_items)
    ? order.line_items
        .map((item, idx) => `${idx + 1}. ${item.name} - ${item.quantity} no${item.quantity > 1 ? "s" : ""}`)
        .join("\n")
    : "No items";

  const trackingNumber = order?.fulfillments?.[0]?.tracking_number || "Not Available";
  const trackingLink = order?.fulfillments?.[0]?.tracking_url || "No link";

  await sendCustomerWhatsapp(
    phone,
    "order_fulfilled",
    [
      customer.first_name || "Customer",
      order.name || "N/A",
      shippedItems,
      trackingNumber,
      trackingLink
    ]
  );

  res.sendStatus(200);
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server running on port", PORT));
