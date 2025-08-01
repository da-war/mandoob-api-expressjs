const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const RiderLocation = require('../models/RiderLocation');
const { auth, authorize } = require('../middleware/auth');
const moment = require('moment');

const router = express.Router();

// Create rider account
router.post('/riders', auth, authorize('admin'), async (req, res) => {
  try {
    const {
      email, password, name, phone, address,
      licenseNumber, vehicleType, vehicleNumber, emergencyContact
    } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const rider = new User({
      email,
      password,
      role: 'rider',
      profile: { name, phone, address },
      riderInfo: {
        licenseNumber,
        vehicleType,
        vehicleNumber,
        emergencyContact
      }
    });

    await rider.save();

    // Create rider location record
    await new RiderLocation({
      rider: rider._id,
      location: { latitude: 0, longitude: 0 },
      isOnline: false
    }).save();

    res.status(201).json({
      message: 'Rider created successfully',
      rider: {
        id: rider._id,
        email: rider.email,
        profile: rider.profile,
        riderInfo: rider.riderInfo,
        isActive: rider.isActive
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all riders
router.get('/riders', auth, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const query = { role: 'rider' };
    
    if (status) {
      query.isActive = status === 'active';
    }

    const riders = await User.find(query)
      .select('-password')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(query);

    // Get rider locations and current orders
    const ridersWithStatus = await Promise.all(riders.map(async (rider) => {
      const location = await RiderLocation.findOne({ rider: rider._id });
      const currentOrder = await Order.findOne({ 
        rider: rider._id, 
        status: { $in: ['assigned', 'picked_up', 'in_transit'] }
      });

      return {
        ...rider.toObject(),
        isOnline: location?.isOnline || false,
        currentLocation: location?.location,
        hasActiveOrder: !!currentOrder
      };
    }));

    res.json({
      riders: ridersWithStatus,
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

// Assign order to rider
router.post('/orders/:orderId/assign', auth, authorize('admin'), async (req, res) => {
  try {
    const { riderId } = req.body;
    
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const rider = await User.findOne({ _id: riderId, role: 'rider', isActive: true });
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found or inactive' });
    }

    // Check if rider has active orders
    const activeOrder = await Order.findOne({
      rider: riderId,
      status: { $in: ['assigned', 'picked_up', 'in_transit'] }
    });

    if (activeOrder) {
      return res.status(400).json({ message: 'Rider already has an active order' });
    }

    order.rider = riderId;
    order.status = 'assigned';
    order.timeline.push({
      status: 'assigned',
      timestamp: new Date(),
      notes: 'Order assigned to rider'
    });

    await order.save();

    // Update rider location with current order
    await RiderLocation.findOneAndUpdate(
      { rider: riderId },
      { currentOrder: order._id }
    );

    res.json({ message: 'Order assigned successfully', order });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all orders for admin
router.get('/orders', auth, authorize('admin'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10, dateFrom, dateTo } = req.query;
    const query = {};
    
    if (status) query.status = status;
    
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }

    const orders = await Order.find(query)
      .populate('business', 'profile businessInfo')
      .populate('rider', 'profile riderInfo')
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

// Get dashboard statistics
router.get('/dashboard/stats', auth, authorize('admin'), async (req, res) => {
  try {
    const today = moment().startOf('day');
    const thisWeek = moment().startOf('week');
    const thisMonth = moment().startOf('month');

    const stats = {
      users: {
        total: await User.countDocuments(),
        businesses: await User.countDocuments({ role: 'business' }),
        riders: await User.countDocuments({ role: 'rider' }),
        activeRiders: await RiderLocation.countDocuments({ isOnline: true })
      },
      orders: {
        total: await Order.countDocuments(),
        today: await Order.countDocuments({ createdAt: { $gte: today.toDate() } }),
        thisWeek: await Order.countDocuments({ createdAt: { $gte: thisWeek.toDate() } }),
        thisMonth: await Order.countDocuments({ createdAt: { $gte: thisMonth.toDate() } }),
        pending: await Order.countDocuments({ status: 'pending' }),
        inProgress: await Order.countDocuments({ 
          status: { $in: ['assigned', 'picked_up', 'in_transit'] }
        }),
        completed: await Order.countDocuments({ status: 'delivered' }),
        cancelled: await Order.countDocuments({ status: { $in: ['cancelled', 'failed'] } })
      },
      revenue: {
        total: (await Order.countDocuments({ paymentStatus: 'paid' })) * 30,
        thisMonth: (await Order.countDocuments({ 
          paymentStatus: 'paid',
          createdAt: { $gte: thisMonth.toDate() }
        })) * 30
      }
    };

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Block/Unblock user
router.patch('/users/:userId/toggle-status', auth, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isActive = !user.isActive;
    await user.save();

    res.json({ 
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        email: user.email,
        isActive: user.isActive
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// # Get all businesses
router.get('/businesses', auth, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const query = { role: 'business' };
    
    if (status) {
      query.isActive = status === 'active';
    }

    const businesses = await User.find(query)
      .select('-password')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(query);

    // Get order statistics for each business
    const businessesWithStats = await Promise.all(businesses.map(async (business) => {
      const orderStats = {
        total: await Order.countDocuments({ business: business._id }),
        completed: await Order.countDocuments({ business: business._id, status: 'delivered' }),
        pending: await Order.countDocuments({ business: business._id, status: 'pending' })
      };

      return {
        ...business.toObject(),
        orderStats
      };
    }));

    res.json({
      businesses: businessesWithStats,
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

module.exports = router;