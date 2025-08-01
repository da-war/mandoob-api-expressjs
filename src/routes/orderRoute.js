const express = require('express');
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const User = require('../models/User');
const RiderLocation = require('../models/RiderLocation');
const { auth, authorize } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../utils/cloudinary');

const router = express.Router();

// Create order
router.post('/', auth, authorize('business'), upload.array('productImages', 5), [
  body('pickupAddress').notEmpty(),
  body('dropoffAddress').notEmpty(),
  body('deliveryDate').isISO8601(),
  body('deliveryTime').notEmpty(),
  body('customerName').notEmpty(),
  body('customerPhone').notEmpty(),
  body('productDescription').notEmpty(),
  body('productWeight').isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      deliveryDate, deliveryTime,
      customerName, customerPhone,
      productDescription, productWeight
    } = req.body;

    // Upload images to Cloudinary
    let productImages = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const imageUrl = await uploadToCloudinary(file.buffer, 'products');
        productImages.push(imageUrl);
      }
    }

    const order = new Order({
      business: req.user._id,
      pickupLocation: {
        address: pickupAddress,
        coordinates: {
          latitude: pickupLat,
          longitude: pickupLng
        }
      },
      dropoffLocation: {
        address: dropoffAddress,
        coordinates: {
          latitude: dropoffLat,
          longitude: dropoffLng
        }
      },
      deliveryDate: new Date(deliveryDate),
      deliveryTime,
      customer: {
        name: customerName,
        phone: customerPhone
      },
      product: {
        description: productDescription,
        weight: parseFloat(productWeight),
        images: productImages
      },
      timeline: [{
        status: 'pending',
        timestamp: new Date(),
        notes: 'Order created'
      }]
    });

    await order.save();

    res.status(201).json({
      message: 'Order created successfully',
      order: await Order.findById(order._id).populate('business', 'profile businessInfo')
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get business orders
router.get('/business', auth, authorize('business'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const query = { business: req.user._id };
    
    if (status) query.status = status;

    const orders = await Order.find(query)
      .populate('rider', 'profile')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Order.countDocuments(query);

    res.json({
      orders,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get rider orders
router.get('/rider', auth, authorize('rider'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const query = { rider: req.user._id };
    
    if (status) query.status = status;

    const orders = await Order.find(query)
      .populate('business', 'profile businessInfo')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Order.countDocuments(query);

    res.json({
      orders,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update order status (rider)
router.patch('/:orderId/status', auth, authorize('rider'), async (req, res) => {
  try {
    const { status, notes, latitude, longitude } = req.body;
    
    const order = await Order.findOne({ _id: req.params.orderId, rider: req.user._id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    order.status = status;
    order.timeline.push({
      status,
      timestamp: new Date(),
      notes,
      location: latitude && longitude ? { latitude, longitude } : undefined
    });

    if (status === 'delivered') {
      order.actualDeliveryTime = new Date();
    }

    await order.save();

    // Emit real-time update
    global.io.to(`order-${order._id}`).emit('status-update', {
      orderId: order._id,
      status,
      timestamp: new Date(),
      location: { latitude, longitude }
    });

    res.json({ message: 'Order status updated successfully', order });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get order details
router.get('/:orderId', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate('business', 'profile businessInfo')
      .populate('rider', 'profile riderInfo');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if user has permission to view this order
    const canView = order.business._id.equals(req.user._id) || 
                   (order.rider && order.rider._id.equals(req.user._id)) ||
                   req.user.role === 'admin';

    if (!canView) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;