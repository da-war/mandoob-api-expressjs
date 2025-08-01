const express = require('express');
const Order = require('../models/Order');
const RiderLocation = require('../models/RiderLocation');
const { auth, authorize } = require('../middleware/auth');
const moment = require('moment');

const router = express.Router();

// Update rider location
router.post('/location', auth, authorize('rider'), async (req, res) => {
  try {
    const { latitude, longitude, isOnline } = req.body;

    const location = await RiderLocation.findOneAndUpdate(
      { rider: req.user._id },
      {
        location: { latitude, longitude },
        isOnline: isOnline !== undefined ? isOnline : true
      },
      { new: true, upsert: true }
    );

    // Emit location update for current order
    if (location.currentOrder) {
      global.io.to(`order-${location.currentOrder}`).emit('location-update', {
        orderId: location.currentOrder,
        location: { latitude, longitude },
        timestamp: new Date()
      });
    }

    res.json({ message: 'Location updated successfully', location });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get rider dashboard stats
router.get('/dashboard', auth, authorize('rider'), async (req, res) => {
  try {
    const today = moment().startOf('day');
    const thisWeek = moment().startOf('week');
    const thisMonth = moment().startOf('month');

    const stats = {
      today: {
        total: await Order.countDocuments({ 
          rider: req.user._id,
          createdAt: { $gte: today.toDate() }
        }),
        completed: await Order.countDocuments({ 
          rider: req.user._id,
          status: 'delivered',
          actualDeliveryTime: { $gte: today.toDate() }
        }),
        pending: await Order.countDocuments({ 
          rider: req.user._id,
          status: { $in: ['assigned', 'picked_up', 'in_transit'] }
        })
      },
      thisWeek: {
        total: await Order.countDocuments({ 
          rider: req.user._id,
          createdAt: { $gte: thisWeek.toDate() }
        }),
        completed: await Order.countDocuments({ 
          rider: req.user._id,
          status: 'delivered',
          actualDeliveryTime: { $gte: thisWeek.toDate() }
        })
      },
      thisMonth: {
        total: await Order.countDocuments({ 
          rider: req.user._id,
          createdAt: { $gte: thisMonth.toDate() }
        }),
        completed: await Order.countDocuments({ 
          rider: req.user._id,
          status: 'delivered',
          actualDeliveryTime: { $gte: thisMonth.toDate() }
        }),
        cancelled: await Order.countDocuments({ 
          rider: req.user._id,
          status: { $in: ['cancelled', 'failed'] },
          createdAt: { $gte: thisMonth.toDate() }
        })
      },
      allTime: {
        total: await Order.countDocuments({ rider: req.user._id }),
        completed: await Order.countDocuments({ rider: req.user._id, status: 'delivered' }),
        cancelled: await Order.countDocuments({ 
          rider: req.user._id,
          status: { $in: ['cancelled', 'failed'] }
        })
      }
    };

    // Get current active order
    const currentOrder = await Order.findOne({
      rider: req.user._id,
      status: { $in: ['assigned', 'picked_up', 'in_transit'] }
    }).populate('business', 'profile businessInfo');

    res.json({ stats, currentOrder });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Toggle online status
router.post('/toggle-online', auth, authorize('rider'), async (req, res) => {
  try {
    const location = await RiderLocation.findOne({ rider: req.user._id });
    if (!location) {
      return res.status(404).json({ message: 'Location record not found' });
    }

    location.isOnline = !location.isOnline;
    await location.save();

    res.json({ 
      message: `Status updated to ${location.isOnline ? 'online' : 'offline'}`,
      isOnline: location.isOnline 
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Mark order as failed with reason
router.post('/orders/:orderId/fail', auth, authorize('rider'), async (req, res) => {
  try {
    const { reason } = req.body;
    
    const order = await Order.findOne({ _id: req.params.orderId, rider: req.user._id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    order.status = 'failed';
    order.failureReason = reason;
    order.timeline.push({
      status: 'failed',
      timestamp: new Date(),
      notes: `Delivery failed: ${reason}`
    });

    await order.save();

    // Update rider location to remove current order
    await RiderLocation.findOneAndUpdate(
      { rider: req.user._id },
      { $unset: { currentOrder: 1 } }
    );

    // Emit status update
    global.io.to(`order-${order._id}`).emit('status-update', {
      orderId: order._id,
      status: 'failed',
      timestamp: new Date(),
      reason
    });

    res.json({ message: 'Order marked as failed', order });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;