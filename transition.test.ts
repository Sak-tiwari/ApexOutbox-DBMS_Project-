import mongoose from 'mongoose';
import { Lead } from '../models/Lead';
import { TransitionService } from '../services/TransitionService';

async function runTests() {
  console.log('🧪 Starting Sales Pipeline State Machine Tests...\n');

  // 1. Connect to local database instance
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect('mongodb://127.0.0.1:27017/business_automation_test');
  }

  try {
    // Clear test arena
    await Lead.deleteMany({});

    // Create a fresh test lead
    const lead = await Lead.create({
      name: 'Test Client',
      company: 'Innovate LLC',
      currentState: 'New',
      ownerId: 'sales_user_1',
      followUpDate: new Date()
    });
    const leadId = lead._id.toString();

    // ==========================================
    // TEST 1: Valid Transition Progression
    // ==========================================
    console.log('🔄 Running Test 1: Valid Transition (New -> Contacted)...');
    const step1 = await TransitionService.transitionLead(leadId, 'Contacted', 'sales_user_1', 0);
    if (step1.currentState === 'Contacted' && step1.activityHistory.length === 1) {
      console.log('✅ Test 1 Passed: State updated and audit history logged!\n');
    } else {
      throw new Error('Test 1 Failed: Incorrect transition behavior.');
    }

    // ==========================================
    // TEST 2: Block Invalid Transition Skips
    // ==========================================
    console.log('🚧 Running Test 2: Block Invalid Transition (Contacted -> Closed-Won)...');
    try {
      // Contacted cannot skip straight to Closed-Won according to state machine rules
      await TransitionService.transitionLead(leadId, 'Closed-Won', 'sales_user_1', 1);
      throw new Error('Test 2 Failed: Illegal transition bypass was allowed!');
    } catch (err: any) {
      if (err.message.includes('Invalid Pipeline Transition')) {
        console.log('✅ Test 2 Passed: Successfully blocked illegal jump!\n');
      } else {
        throw err;
      }
    }

    // ==========================================
    // TEST 3: Block Reopening Without Reason Guard
    // ==========================================
    console.log('🛡️ Running Test 3: Block Controlled Reopening without explanation...');
    // Manually force state to a closed stage to test reopening rules
    await Lead.findByIdAndUpdate(leadId, { currentState: 'Closed-Lost', __v: 2 });
    try {
      await TransitionService.transitionLead(leadId, 'New', 'sales_user_1', 2);
      throw new Error('Test 3 Failed: Allowed reopening a closed lead without a reason string!');
    } catch (err: any) {
      if (err.message.includes('Reopening Guard')) {
        console.log('✅ Test 3 Passed: Reopening blocked without a documented reason log!\n');
      } else {
        throw err;
      }
    }

    // ==========================================
    // TEST 4: Optimistic Concurrency Protection
    // ==========================================
    console.log('🛑 Running Test 4: Optimistic Concurrency Guard...');
    // Reset lead back to a clean progression path stage
    await Lead.findByIdAndUpdate(leadId, { currentState: 'New', __v: 10 });
    try {
      // Intentionally passing an obsolete out-of-date version (0) instead of current version (10)
      await TransitionService.transitionLead(leadId, 'Contacted', 'sales_user_1', 0);
      throw new Error('Test 4 Failed: Allowed a stale concurrent update request to complete!');
    } catch (err: any) {
      if (err.message.includes('Concurrency Conflict')) {
        console.log('✅ Test 4 Passed: Outdated concurrent request rejected safely!\n');
      } else {
        throw err;
      }
    }

    console.log('🎉 ALL ASSIGNMENT STATE MACHINE TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error: any) {
    console.error('❌ A test failed during pipeline validation Execution:', error.message);
  } finally {
    // Clean exit
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
    process.exit(0);
  }
}

runTests();