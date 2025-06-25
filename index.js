require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

// HMAC Verification Middleware
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  if (digest === hmacHeader) {
    console.log("✅ HMAC validation passed");
    return next();
  } else {
    console.warn("⚠️ HMAC validation failed!");
    console.log("🔍 Expected:", digest);
    console.log("📬 Received:", hmacHeader);
    return res.status(401).send("Unauthorized - HMAC validation failed");
  }
}

// Utility function to get customer phone
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

// Function to send WhatsApp template message to customer
const sendCustomerWhatsapp = async (phone, templateName, params) => {
  try {
    console.log(`📱 Sending WhatsApp template "${templateName}" to ${phone}`);
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
    console.log("✅ Customer WhatsApp message sent successfully");
  } catch (err) {
    console.error("❌ Customer WhatsApp Error:", err.response?.data || err.message);
  }
};

// Function to send WhatsApp text message to admin
const sendAdminWhatsapp = async (message) => {
  try {
    console.log("📱 Sending admin notification via WhatsApp");
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
    console.log("✅ Admin WhatsApp message sent successfully");
  } catch (err) {
    console.error("❌ Admin WhatsApp send error:", err.response?.data || err.message);
  }
};

// Main webhook handler for new orders
app.post("/webhook/orders/create", verifyShopifyWebhook, async (req, res) => {
  try {
    console.log("🎯 New order webhook received");
    const order = req.body;

    // Validate order data
    if (!order || typeof order !== "object") {
      console.error("❌ Invalid or empty order payload");
      return res.status(400).send("Invalid payload");
    }

    const customer = order.customer;
    if (!customer) {
      console.error("❌ Order received but 'customer' field is missing");
      return res.status(400).send("Missing customer info");
    }

    // Extract order details
    const total = order.total_price;
    const orderId = order.name;
    const phone = customer.phone || customer.default_address?.phone || "Not Provided";
    const address = order.shipping_address || order.billing_address;
    const paymentMethod = order.gateway || "Not specified";

    // Format address
    const fullAddress = address 
      ? `${address.name || ''}, ${address.address1 || ''}, ${address.address2 || ''}, ${address.city}, ${address.province}, ${address.zip}, ${address.country}`
      : "Address not provided";

    // Format product list
    const products = order.line_items && Array.isArray(order.line_items)
      ? order.line_items
          .map((item, index) => `${index + 1}. ${item.name} - ${item.quantity} nos`)
          .join("\n")
      : "No items";

    // Admin notification message
    const adminMessage = `Dear Arun,\n\n` +
      `🛍️ New Order received on Shopify. Please visit Shopify and fulfill the items.\n\n` +
      `📦 Order ID: ${orderId}\n` +
      `👤 Customer Name: ${customer.first_name} ${customer.last_name}\n` +
      `📱 Contact No: ${phone}\n` +
      `🚚 Shipping Address:\n${fullAddress}\n` +
      `💳 Payment Method: ${paymentMethod}\n` +
      `🧾 Products:\n${products}\n\n` +
      `💰 Total Amount: ₹${total}\n\n` +
      `Thanks and Regards,\nNanic Ayurveda Bot`;

    // Send admin notification
    await sendAdminWhatsapp(adminMessage);

    // Send customer confirmation if phone is available
    const customerPhone = getCustomerPhone(customer);
    if (customerPhone) {
      const productsList = order.line_items && Array.isArray(order.line_items)
        ? order.line_items
            .map((item, idx) => `${idx + 1}. ${item.name} - ${item.quantity} no${item.quantity > 1 ? "s" : ""}`)
            .join("\n")
        : "No items";

      await sendCustomerWhatsapp(
        customerPhone,
        "order_confirmation",
        [
          customer.first_name || "Customer",
          order.name || "Order",
          total?.toString() || "N/A",
          productsList
        ]
      );
    } else {
      console.warn("⚠️ Customer phone not available for order confirmation");
    }

    console.log("✅ Order processed successfully:", orderId);
    res.status(200).send("OK");

  } catch (error) {
    console.error("❌ Error processing order webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Order fulfillment webhook
app.post("/webhook/orders/fulfilled", verifyShopifyWebhook, async (req, res) => {
  try {
    console.log("📦 Order fulfillment webhook received");
    const order = req.body;

    const customer = order.customer;
    if (!customer || typeof customer !== "object") {
      console.error("❌ Order received but 'customer' field is missing");
      return res.status(400).send("Missing customer info");
    }

    const phone = getCustomerPhone(customer);
    if (!phone) {
      console.error("❌ Phone number not found for fulfillment notification");
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

    console.log("✅ Fulfillment notification sent successfully");
    res.status(200).send("OK");

  } catch (error) {
    console.error("❌ Error processing fulfillment webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Test endpoint (remove in production)
app.post("/test", (req, res) => {
  console.log("Test endpoint hit:", req.body);
  res.json({ received: true, body: req.body });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
  console.log("🔧 Environment variables check:");
  console.log("- SHOPIFY_WEBHOOK_SECRET:", process.env.SHOPIFY_WEBHOOK_SECRET ? "✅ Set" : "❌ Missing");
  console.log("- WHATSAPP_PHONE_NUMBER_ID:", process.env.WHATSAPP_PHONE_NUMBER_ID ? "✅ Set" : "❌ Missing");
  console.log("- WHATSAPP_TOKEN:", process.env.WHATSAPP_TOKEN ? "✅ Set" : "❌ Missing");
  console.log("- TO_WHATSAPP_NUMBER:", process.env.TO_WHATSAPP_NUMBER ? "✅ Set" : "❌ Missing");
});