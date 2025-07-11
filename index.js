require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

// Keep-alive configuration
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const INACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds

// Activity tracking
let lastActivity = Date.now();
let keepAliveInterval = null;

// Function to update last activity
const updateActivity = () => {
  lastActivity = Date.now();
};

// Function to send keep-alive request
const sendKeepAlive = async () => {
  try {
    const timeSinceLastActivity = Date.now() - lastActivity;
    console.log(`Checking activity: ${Math.round(timeSinceLastActivity / 1000)}s since last activity`);
    
    if (timeSinceLastActivity > INACTIVITY_THRESHOLD) {
      console.log('Sending keep-alive request to prevent spin-down');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(`${KEEP_ALIVE_URL}/health`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Keep-Alive-Bot',
          'X-Keep-Alive': 'true'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        console.log('Keep-alive request successful');
      } else {
        console.warn(`Keep-alive request failed with status: ${response.status}`);
      }
    } else {
      console.log('Recent activity detected, skipping keep-alive request');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Keep-alive request timed out');
    } else {
      console.error('Keep-alive request failed:', error.message);
    }
  }
};

// Start keep-alive monitoring (enable if KEEP_ALIVE_URL is set)
if (process.env.KEEP_ALIVE_URL) {
  keepAliveInterval = setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL);
  console.log(`Keep-alive monitoring started (checking every ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
}

// Activity tracking middleware (must be before other middleware)
app.use((req, res, next) => {
  // Don't count keep-alive requests as activity
  if (req.get('X-Keep-Alive') !== 'true') {
    updateActivity();
  }
  next();
});

// Logging middleware
app.use((req, res, next) => {
  const isKeepAlive = req.get('X-Keep-Alive') === 'true';
  if (!isKeepAlive) {
    console.log(`${req.method} ${req.path} - ${req.ip}`);
  } else {
    console.log(`Keep-alive request: ${req.method} ${req.path}`);
  }
  next();
});

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

  // Remove all spaces and "+" sign
  let cleanedPhone = rawPhone.replace(/\s+/g, "").replace(/^\+/, "");
  
  // Check if it's a valid phone number
  if (!cleanedPhone || cleanedPhone.length < 10) {
    console.warn(`⚠️ Invalid phone number: ${rawPhone} (too short)`);
    return null;
  }
  
  // If it starts with 91 and has 12 digits total, it's already in correct format
  if (cleanedPhone.startsWith("91") && cleanedPhone.length === 12) {
    return cleanedPhone;
  }
  
  // If it has 10 digits and doesn't start with 91, add 91 prefix
  if (cleanedPhone.length === 10 && !cleanedPhone.startsWith("91")) {
    return `91${cleanedPhone}`;
  }
  
  // If it has 11 digits and starts with 0, replace 0 with 91
  if (cleanedPhone.length === 11 && cleanedPhone.startsWith("0")) {
    return `91${cleanedPhone.substring(1)}`;
  }
  
  // If it already has 12 digits but doesn't start with 91, assume it's valid
  if (cleanedPhone.length === 12) {
    return cleanedPhone;
  }
  
  // If none of the above conditions match, log warning and return null
  console.warn(`⚠️ Invalid phone number format: ${rawPhone} (cleaned: ${cleanedPhone}, length: ${cleanedPhone.length})`);
  return null;
};

// Function to get admin details
const getAdminDetails = () => {
  const adminNumbers = process.env.ADMIN_WHATSAPP_NUMBERS;
  const adminNames = process.env.ADMIN_NAMES;
  const adminContacts = process.env.ADMIN_CONTACTS;
  
  if (!adminNumbers) {
    console.warn("⚠️ ADMIN_WHATSAPP_NUMBERS not set in environment");
    return [];
  }

  const numbers = adminNumbers.split(',').map(num => num.trim()).filter(num => num.length > 0);
  const names = adminNames ? adminNames.split(',').map(name => name.trim()) : [];
  const contacts = adminContacts ? adminContacts.split(',').map(contact => contact.trim()) : [];

  return numbers.map((num, index) => ({
    phone: num.startsWith('91') ? num : `91${num}`,
    name: names[index] || 'Admin',
    contact: contacts[index] || num
  }));
};

// Function to get admin phone numbers (for backward compatibility)
const getAdminNumbers = () => {
  return getAdminDetails().map(admin => admin.phone);
};

// Function to extract tracking information from Shopify order
const extractTrackingInfo = (order) => {
  console.log("🔍 Extracting tracking info from order:", order.name);
  
  // Log all fulfillments for debugging
  if (order.fulfillments && order.fulfillments.length > 0) {
    console.log("📦 Found fulfillments:", order.fulfillments.length);
    order.fulfillments.forEach((fulfillment, index) => {
      console.log(`   Fulfillment ${index + 1}:`, {
        id: fulfillment.id,
        tracking_number: fulfillment.tracking_number,
        tracking_url: fulfillment.tracking_url,
        tracking_company: fulfillment.tracking_company,
        tracking_numbers: fulfillment.tracking_numbers,
        tracking_urls: fulfillment.tracking_urls
      });
    });
  } else {
    console.log("⚠️ No fulfillments found in order");
  }

  // Check for tracking in fulfillments
  let trackingNumber = "Not Available";
  let trackingLink = "No link";
  let trackingCompany = "Not specified";

  if (order.fulfillments && order.fulfillments.length > 0) {
    const fulfillment = order.fulfillments[0]; // Get first fulfillment
    
    // Try different tracking number fields
    if (fulfillment.tracking_numbers && fulfillment.tracking_numbers.length > 0) {
      trackingNumber = fulfillment.tracking_numbers[0];
    } else if (fulfillment.tracking_number) {
      trackingNumber = fulfillment.tracking_number;
    }
    
    // Try different tracking URL fields
    if (fulfillment.tracking_urls && fulfillment.tracking_urls.length > 0) {
      trackingLink = fulfillment.tracking_urls[0];
    } else if (fulfillment.tracking_url) {
      trackingLink = fulfillment.tracking_url;
    }
    
    // Get tracking company
    if (fulfillment.tracking_company) {
      trackingCompany = fulfillment.tracking_company;
    }
  }

  // Check for tracking in line items (some apps store tracking there)
  if (order.line_items && Array.isArray(order.line_items)) {
    order.line_items.forEach((item, index) => {
      if (item.fulfillment && item.fulfillment.tracking_number) {
        console.log(`   Line item ${index + 1} has tracking:`, item.fulfillment.tracking_number);
        if (trackingNumber === "Not Available") {
          trackingNumber = item.fulfillment.tracking_number;
        }
      }
    });
  }

  // Check for tracking in shipping lines
  if (order.shipping_lines && Array.isArray(order.shipping_lines)) {
    order.shipping_lines.forEach((shipping, index) => {
      console.log(`   Shipping line ${index + 1}:`, {
        title: shipping.title,
        carrier_identifier: shipping.carrier_identifier,
        code: shipping.code
      });
    });
  }

  console.log("📋 Final tracking info:", {
    trackingNumber,
    trackingLink,
    trackingCompany
  });

  return {
    trackingNumber,
    trackingLink,
    trackingCompany
  };
};

// Function to send WhatsApp template message to customer
const sendCustomerWhatsapp = async (phone, templateName, params) => {
  try {
    updateActivity(); // Update activity when sending messages
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

// Function to send WhatsApp template message to admin(s)
const sendAdminWhatsapp = async (templateName, baseParams) => {
  try {
    updateActivity(); // Update activity when sending messages
    const adminDetails = getAdminDetails();
    
    if (adminDetails.length === 0) {
      console.error("❌ No admin details configured");
      return;
    }

    console.log(`📱 Sending WhatsApp template "${templateName}" to ${adminDetails.length} admin(s)`);
    console.log(`📋 Template parameters:`, baseParams);
    
    const promises = adminDetails.map(async (admin) => {
      try {
        // Create personalized parameters for each admin
        const params = [admin.name, ...baseParams];
        
        console.log(`📤 Sending to ${admin.name} (${admin.phone}) with params:`, params);
        
        await axios.post(
          `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: admin.phone,
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
        console.log(`✅ Admin WhatsApp message sent successfully to ${admin.name} (${admin.phone})`);
      } catch (err) {
        console.error(`❌ Admin WhatsApp Error for ${admin.name} (${admin.phone}):`, err.response?.data || err.message);
      }
    });

    await Promise.all(promises);
    console.log("✅ All admin notifications sent");
  } catch (err) {
    console.error("❌ Admin WhatsApp send error:", err.message);
  }
};

// Function to send WhatsApp text message to admin (fallback)
const sendAdminWhatsappText = async (message) => {
  try {
    updateActivity(); // Update activity when sending messages
    const adminDetails = getAdminDetails();
    
    if (adminDetails.length === 0) {
      console.error("❌ No admin details configured");
      return;
    }

    console.log(`📱 Sending text message to ${adminDetails.length} admin(s)`);
    
    const promises = adminDetails.map(async (admin) => {
      try {
        // Personalize the message for each admin
        const personalizedMessage = message.replace(/Dear\s+\w+,/, `Dear ${admin.name},`);
        
        await axios.post(
          `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: admin.phone,
            type: "text",
            text: { body: personalizedMessage },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log(`✅ Admin text message sent successfully to ${admin.name} (${admin.phone})`);
      } catch (err) {
        console.error(`❌ Admin text message error for ${admin.name} (${admin.phone}):`, err.response?.data || err.message);
      }
    });

    await Promise.all(promises);
    console.log("✅ All admin text notifications sent");
  } catch (err) {
    console.error("❌ Admin text message send error:", err.message);
  }
};

// Main webhook handler for new orders
app.post("/webhook/orders/create", verifyShopifyWebhook, async (req, res) => {
  updateActivity(); // Update activity on webhook calls
  
  try {
    console.log("🎯 New order webhook received");
    console.log("📦 Order ID:", req.body?.name || "Unknown");
    console.log("⏰ Timestamp:", new Date().toISOString());
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
      ? `${address.name || ''}, ${address.address1 || ''}, ${address.address2 || ''}, ${address.city}, ${address.province}, ${address.zip}, ${address.country}`.replace(/,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '')
      : "Address not provided";

    // Format product list
    const products = order.line_items && Array.isArray(order.line_items)
      ? order.line_items
          .map((item, index) => `${index + 1}. ${item.name} - ${item.quantity} nos`)
          .join(", ")
      : "No items";

    // Send admin notification using template
    await sendAdminWhatsapp("admin_new_order", [
      orderId,
      `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      phone,
      fullAddress,
      paymentMethod,
      products,
      total?.toString() || "0"
    ]);

    // Send customer confirmation if phone is available
    const customerPhone = getCustomerPhone(customer);
    if (customerPhone) {
      const productsList = order.line_items && Array.isArray(order.line_items)
        ? order.line_items
            .map((item, idx) => `${idx + 1}. ${item.name} - ${item.quantity} no${item.quantity > 1 ? "s" : ""}`)
            .join(", ")
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
  updateActivity(); // Update activity on webhook calls
  
  try {
    console.log("📦 Order fulfillment webhook received");
    console.log("📦 Order ID:", req.body?.name || "Unknown");
    console.log("⏰ Timestamp:", new Date().toISOString());
    const order = req.body;

    const customer = order.customer;
    if (!customer || typeof customer !== "object") {
      console.error("❌ Order received but 'customer' field is missing");
      return res.status(400).send("Missing customer info");
    }

    const phone = getCustomerPhone(customer);
    const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    const orderId = order.name || "N/A";
    
    const shippedItems = Array.isArray(order.line_items)
      ? order.line_items
          .map((item, idx) => `${idx + 1}. ${item.name} - ${item.quantity} no${item.quantity > 1 ? "s" : ""}`)
          .join(", ")
      : "No items";

    // Extract tracking information using the comprehensive function
    const trackingInfo = extractTrackingInfo(order);
    const { trackingNumber, trackingLink } = trackingInfo;

    // Send customer notification if phone is available
    if (phone) {
      await sendCustomerWhatsapp(
        phone,
        "order_fulfilled",
        [
          customer.first_name || "Customer",
          orderId,
          shippedItems,
          trackingNumber,
          trackingLink
        ]
      );
      console.log("✅ Customer fulfillment notification sent");
    } else {
      console.warn("⚠️ Customer phone not available for fulfillment notification");
    }

    // Send admin notification
    await sendAdminWhatsapp("admin_order_fulfilled", [
      orderId,                    // {{2}} - Order Number
      customerName || "Customer", // {{3}} - Customer Name
      phone || "Not Provided",    // {{4}} - Customer Phone
      shippedItems,               // {{5}} - Items Shipped
      trackingNumber,             // {{6}} - Tracking Number
      trackingLink                // {{7}} - Tracking Link
    ]);

    console.log("✅ Fulfillment notifications sent successfully");
    res.status(200).send("OK");

  } catch (error) {
    console.error("❌ Error processing fulfillment webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Enhanced health check with activity info
app.get("/health", (req, res) => {
  const isKeepAlive = req.get('X-Keep-Alive') === 'true';
  const timeSinceLastActivity = Date.now() - lastActivity;
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    lastActivity: new Date(lastActivity).toISOString(),
    timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000),
    isKeepAliveRequest: isKeepAlive,
    adminDetails: getAdminDetails()
  });
});

// Activity status endpoint
app.get('/activity-status', (req, res) => {
  const timeSinceLastActivity = Date.now() - lastActivity;
  res.json({
    lastActivity: new Date(lastActivity).toISOString(),
    timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000),
    thresholdSeconds: INACTIVITY_THRESHOLD / 1000,
    isInactive: timeSinceLastActivity > INACTIVITY_THRESHOLD,
    keepAliveEnabled: !!(process.env.KEEP_ALIVE_URL),
    adminDetails: getAdminDetails()
  });
});

// Test endpoint (remove in production)
app.post("/test", (req, res) => {
  updateActivity(); // Update activity on test calls
  console.log("Test endpoint hit:", req.body);
  res.json({ received: true, body: req.body });
});

// Test tracking extraction endpoint
app.post("/test-tracking", (req, res) => {
  updateActivity(); // Update activity on test calls
  console.log("Test tracking endpoint hit");
  
  if (req.body && req.body.order) {
    const trackingInfo = extractTrackingInfo(req.body.order);
    res.json({ 
      success: true, 
      trackingInfo,
      orderId: req.body.order.name 
    });
  } else {
    res.json({ 
      success: false, 
      error: "No order data provided" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Keep-alive monitoring: ${(process.env.KEEP_ALIVE_URL) ? 'ENABLED' : 'DISABLED'}`);
  console.log("🔧 Environment variables check:");
  console.log("- SHOPIFY_WEBHOOK_SECRET:", process.env.SHOPIFY_WEBHOOK_SECRET ? "✅ Set" : "❌ Missing");
  console.log("- WHATSAPP_PHONE_NUMBER_ID:", process.env.WHATSAPP_PHONE_NUMBER_ID ? "✅ Set" : "❌ Missing");
  console.log("- WHATSAPP_TOKEN:", process.env.WHATSAPP_TOKEN ? "✅ Set" : "❌ Missing");
  console.log("- ADMIN_WHATSAPP_NUMBERS:", process.env.ADMIN_WHATSAPP_NUMBERS ? "✅ Set" : "❌ Missing");
  console.log("- ADMIN_NAMES:", process.env.ADMIN_NAMES ? "✅ Set" : "❌ Missing");
  console.log("- ADMIN_CONTACTS:", process.env.ADMIN_CONTACTS ? "✅ Set" : "❌ Missing");
  console.log("- KEEP_ALIVE_URL:", process.env.KEEP_ALIVE_URL ? "✅ Set" : "❌ Missing");
  
  const adminDetails = getAdminDetails();
  console.log("📱 Admin details configured:", adminDetails.length);
  adminDetails.forEach((admin, idx) => {
    console.log(`   ${idx + 1}. ${admin.name} - ${admin.phone} (Contact: ${admin.contact})`);
  });
});
